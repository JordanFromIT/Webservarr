"""
Library events in the event log (spec
docs/superpowers/specs/2026-10-05-event-log-library-events-design.md): the
translation table (app/services/library_lines.py, one case per row of the
spec's section 3), Sonarr's grouping and the 10-minute leftovers
(status_feed.record_library_event, notification_poller.tidy_library_lines),
POST /api/webhooks/{app} (app/routers/chaptarr_webhook.py) and library lines
staying out of the pins, pushes and state while still showing Home's event
log without Uptime Kuma.

Payloads are shaped like the apps' own (the spike's field tables:
.superpowers/sdd/2026-10-05-event-log-sources/spike.md), with the fields a
line must never show (requester, paths, release names) filled in so the
privacy checks have something to leak.
"""
import asyncio
import base64
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from unittest import mock

from app.services import library_lines
from app.tests import helpers

try:
    import fastapi  # noqa: F401 - only present with the app's dependencies
    import sqlalchemy  # noqa: F401
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no app dependencies
    HAVE_APP = False

if HAVE_APP:
    from sqlalchemy.orm import sessionmaker

    from app.models import StatusUpdate
    from app.services import notification_poller as poller
    from app.services import status_feed
    from app.tests.test_notification_poller import FakeRedis

T0 = datetime(2026, 10, 5, 12, 0, 0)
SECRETS = {"sonarr": "sonarr-test-secret", "radarr": "radarr-test-secret", "chaptarr": "chaptarr-test-secret"}

# Words that sit in real payloads and must never reach a line.
PRIVATE = ("requester-jane", "/data/media", "/downloads/complete", "Dune.2021.2160p.WEB-DL.DDP5.1-GROUP",
           "The.Bear.S03.1080p.WEB.h264-ETHEL", "Dune.Messiah.M4B-RG", "abc123hash")


# --- Payloads ------------------------------------------------------------------------------

def movie(title="Dune", year=2021, movie_id=11):
    return {"id": movie_id, "title": title, "year": year, "folderPath": "/data/media/movies/Dune (2021)",
            "tmdbId": 438631, "tags": ["requester-jane"]}


def release(title="Dune.2021.2160p.WEB-DL.DDP5.1-GROUP", quality="WEBDL-2160p"):
    return {"quality": quality, "releaseTitle": title, "indexer": "Indexer", "releaseGroup": "GROUP", "size": 1}


def radarr(event, **fields):
    body = {"eventType": event, "instanceName": "Radarr", "applicationUrl": "", "movie": movie()}
    body.update(fields)
    return body


def movie_file(file_id=301, quality="WEBDL-2160p"):
    return {"id": file_id, "relativePath": "Dune (2021).mkv", "path": "/data/media/movies/Dune (2021)/Dune.mkv",
            "quality": quality, "sceneName": "Dune.2021.2160p.WEB-DL.DDP5.1-GROUP"}


def series(title="Severance", series_id=21):
    return {"id": series_id, "title": title, "year": 2022, "path": "/data/media/tv/" + title, "tvdbId": 371980,
            "tags": ["requester-jane"]}


def episode(season, number, title="An Episode"):
    return {"id": season * 100 + number, "seasonNumber": season, "episodeNumber": number, "title": title}


def episode_file(file_id, quality="WEBDL-1080p"):
    return {"id": file_id, "relativePath": f"Season 03/{file_id}.mkv", "path": f"/data/media/tv/x/{file_id}.mkv",
            "quality": quality, "sceneName": "The.Bear.S03.1080p.WEB.h264-ETHEL"}


def sonarr(event, title="Severance", episodes=None, **fields):
    body = {"eventType": event, "instanceName": "Sonarr", "applicationUrl": "", "series": series(title)}
    if episodes is not None:
        body["episodes"] = episodes
    body.update(fields)
    return body


def per_file(title, season, number, file_id, upgrade=False, quality="WEBDL-1080p", download="abc123hash"):
    """Sonarr's On File Import / On File Upgrade: one episode file."""
    return sonarr("Download", title, [episode(season, number)], episodeFile=episode_file(file_id, quality),
                  isUpgrade=upgrade, downloadId=download, release={"releaseTitle": "The.Bear.S03.1080p.WEB.h264-ETHEL"},
                  deletedFiles=[{"quality": "HDTV-720p", "path": "/data/media/tv/old.mkv"}] if upgrade else [])


def complete(title, season, numbers, file_ids, quality="WEBDL-1080p", download="abc123hash"):
    """Sonarr's On Import Complete: also eventType Download, with episodeFiles."""
    body = sonarr("Download", title, [episode(season, n) for n in numbers],
                  episodeFiles=[episode_file(i, quality) for i in file_ids],
                  release={"releaseTitle": "The.Bear.S03.1080p.WEB.h264-ETHEL", "releaseType": "seasonPack"},
                  sourcePath="/downloads/complete/The.Bear.S03", destinationPath="/data/media/tv/The Bear")
    if download is not None:
        body["downloadId"] = download
    return body


def author(name="Frank Herbert", path="/audiobooks/Frank Herbert", author_id=41):
    return {"id": author_id, "name": name, "path": path}


def book(title="Dune Messiah", book_id=51):
    return {"id": book_id, "title": title, "releaseDate": "1969-10-15T00:00:00Z"}


def book_file(file_id=61, quality="M4B", path="/audiobooks/Frank Herbert/Dune Messiah/Dune Messiah.m4b"):
    return {"id": file_id, "path": path, "quality": quality, "sceneName": "Dune.Messiah.M4B-RG"}


def chaptarr(event, **fields):
    body = {"eventType": event, "instanceName": "Chaptarr", "author": author()}
    body.update(fields)
    return body


# --- 1. The translation table: every row of section 3 -------------------------------------

# (row, app, body, line, note). line None: no line.
ROWS = [
    # Radarr
    ("Radarr On Grab", "radarr", radarr("Grab", release=release(), downloadId="abc123hash"),
     "Movie Downloading: Dune (2021)", "not guaranteed"),
    ("Radarr On File Import", "radarr", radarr("Download", movieFile=movie_file(), isUpgrade=False,
                                               downloadId="abc123hash"),
     "Movie Added: Dune (2021)", ""),
    ("Radarr On File Upgrade", "radarr", radarr("Download", movieFile=movie_file(), isUpgrade=True,
                                                deletedFiles=[{"quality": "Bluray-1080p"}]),
     "Movie Upgraded: Dune (2021), now 4K", ""),
    ("Radarr On Movie Added", "radarr", radarr("MovieAdded", movie=movie("Dune Messiah", 2026, 12), addMethod="manual"),
     "Movie Monitored: Dune Messiah (2026)", ""),
    ("Radarr On Movie Delete, files kept", "radarr", radarr("MovieDelete", deletedFiles=False, movieFolderSize=1),
     "Movie Unmonitored: Dune (2021)", ""),
    ("Radarr On Movie Delete, files deleted", "radarr", radarr("MovieDelete", deletedFiles=True),
     "Movie Removed: Dune (2021)", ""),
    ("Radarr On Movie File Delete, not for an upgrade", "radarr",
     radarr("MovieFileDelete", movieFile=movie_file(), deleteReason="manual"), "Movie Removed: Dune (2021)", ""),
    ("Radarr On Movie File Delete for an upgrade", "radarr",
     radarr("MovieFileDelete", movieFile=movie_file(), deleteReason="upgrade"), None, ""),
    ("Radarr On Rename", "radarr", radarr("Rename"), None, ""),
    ("Radarr On Health Issue", "radarr", {"eventType": "Health", "level": "warning", "message": "x"}, None, ""),
    ("Radarr On Health Restored", "radarr", {"eventType": "HealthRestored", "message": "x"}, None, ""),
    ("Radarr On Application Update", "radarr", {"eventType": "ApplicationUpdate", "message": "x"}, None, ""),
    ("Radarr On Manual Interaction Required", "radarr", radarr("ManualInteractionRequired"), None, ""),
    ("Radarr test ping", "radarr", radarr("Test"), None, ""),
    # Sonarr
    ("Sonarr On Grab, one episode", "sonarr",
     sonarr("Grab", "Severance", [episode(2, 3)], release=release("Severance.S02E03.1080p"), downloadId="abc123hash"),
     "Episode Downloading: Severance S02E03", "not guaranteed"),
    ("Sonarr On Grab, several episodes", "sonarr",
     sonarr("Grab", "The Bear", [episode(3, n) for n in range(1, 9)], release=release(), downloadId="abc123hash"),
     "Episodes Downloading: The Bear S03 (8)", "not guaranteed"),
    ("Sonarr On Rename", "sonarr", sonarr("Rename", "The Bear", renamedEpisodeFiles=[
        {"previousRelativePath": "a.mkv", "relativePath": "b.mkv", "path": "/data/media/tv/b.mkv"}]),
     "Files Renamed: The Bear", ""),
    ("Sonarr On Series Add", "sonarr", sonarr("SeriesAdd", "The Bear"), "Series Monitored: The Bear", ""),
    ("Sonarr On Series Delete, files kept", "sonarr", sonarr("SeriesDelete", "The Bear", deletedFiles=False),
     "Series Unmonitored: The Bear", ""),
    ("Sonarr On Series Delete, files deleted", "sonarr", sonarr("SeriesDelete", "The Bear", deletedFiles=True),
     "Series Removed: The Bear", ""),
    ("Sonarr On Episode File Delete, not for an upgrade", "sonarr",
     sonarr("EpisodeFileDelete", "Severance", [episode(2, 3)], episodeFile=episode_file(9), deleteReason="manual"),
     "Episode Removed: Severance S02E03", ""),
    ("Sonarr On Episode File Delete For Upgrade", "sonarr",
     sonarr("EpisodeFileDelete", "Severance", [episode(2, 3)], episodeFile=episode_file(9), deleteReason="upgrade"),
     None, ""),
    ("Sonarr On Health Issue", "sonarr", {"eventType": "Health", "message": "x"}, None, ""),
    ("Sonarr On Health Restored", "sonarr", {"eventType": "HealthRestored", "message": "x"}, None, ""),
    ("Sonarr On Application Update", "sonarr", {"eventType": "ApplicationUpdate"}, None, ""),
    ("Sonarr On Manual Interaction Required", "sonarr", sonarr("ManualInteractionRequired", "The Bear"), None, ""),
    ("Sonarr test ping", "sonarr", sonarr("Test"), None, ""),
    # Chaptarr
    ("Chaptarr On Grab, audiobook", "chaptarr",
     chaptarr("Grab", books=[book()], release={"quality": "M4B", "releaseTitle": "Dune.Messiah.M4B-RG"},
              downloadId="abc123hash"),
     "Audiobook Downloading: Dune Messiah", "not guaranteed"),
    ("Chaptarr On Grab, ebook", "chaptarr",
     chaptarr("Grab", author=author(path="/ebooks/Frank Herbert"), books=[book()], release={"quality": "EPUB"},
              downloadId="abc123hash"),
     "Ebook Downloading: Dune Messiah", "not guaranteed"),
    ("Chaptarr On Release Import", "chaptarr",
     chaptarr("Download", book=book(), bookFiles=[book_file()], isUpgrade=False, downloadId="abc123hash"),
     "Audiobook Added: Dune Messiah", ""),
    ("Chaptarr On Release Import, ebook", "chaptarr",
     chaptarr("Download", book=book(), bookFiles=[book_file(quality="EPUB", path="/ebooks/F/D.epub")],
              isUpgrade=False),
     "Ebook Added: Dune Messiah", ""),
    ("Chaptarr On Upgrade", "chaptarr",
     chaptarr("Download", book=book(), bookFiles=[book_file()], isUpgrade=True, deletedFiles=[{"quality": "MP3"}]),
     "Audiobook Upgraded: Dune Messiah", ""),
    ("Chaptarr On Book Delete, files kept", "chaptarr", chaptarr("BookDelete", book=book(), deletedFiles=False),
     "Book Unmonitored: Dune Messiah", ""),
    ("Chaptarr On Book Delete, files deleted", "chaptarr", chaptarr("BookDelete", book=book(), deletedFiles=True),
     "Book Removed: Dune Messiah", ""),
    ("Chaptarr On Book File Delete", "chaptarr", chaptarr("BookFileDelete", book=book(), bookFile=book_file()),
     "Audiobook Removed: Dune Messiah", ""),
    ("Chaptarr On Book File Delete, ebook", "chaptarr",
     chaptarr("BookFileDelete", author=author(path="/books/F"), book=book(),
              bookFile=book_file(quality="EPUB", path="/books/F/D.epub")),
     "Ebook Removed: Dune Messiah", ""),
    ("Chaptarr On Author Delete, files kept", "chaptarr", chaptarr("AuthorDelete", deletedFiles=False),
     "Author Unmonitored: Frank Herbert", ""),
    ("Chaptarr On Author Delete, files deleted", "chaptarr", chaptarr("AuthorDelete", deletedFiles=True),
     "Author Removed: Frank Herbert", ""),
    ("Chaptarr On Rename", "chaptarr", chaptarr("Rename", book=book()), None, ""),
    ("Chaptarr On Author Added", "chaptarr", chaptarr("AuthorAdded"), None, ""),
    ("Chaptarr On Book Added", "chaptarr", chaptarr("BookAdded", book=book()), None, ""),
    ("Chaptarr On Retag", "chaptarr", chaptarr("Retag", book=book()), None, ""),
    ("Chaptarr On Health", "chaptarr", {"eventType": "Health"}, None, ""),
    ("Chaptarr test ping", "chaptarr", chaptarr("Test"), None, ""),
]


class Translation(unittest.TestCase):
    def test_every_row_of_the_table(self):
        for row, app, body, line, note in ROWS:
            with self.subTest(row=row):
                event = library_lines.translate(app, body)
                if line is None:
                    self.assertIsNone(event)
                    continue
                self.assertIsNotNone(event)
                self.assertEqual(event.text, line)
                self.assertEqual(event.note, note)
                self.assertEqual(event.kind_word == "grab", bool(note))

    def test_sonarr_imports_are_held_per_file_and_grouped_by_import_complete(self):
        one = library_lines.translate("sonarr", per_file("Severance", 2, 3, 901))
        self.assertEqual((one.kind, one.text, one.key, one.kind_word),
                         ("file", "Episode Added: Severance S02E03", "sonarr:file:901", "import"))
        up = library_lines.translate("sonarr", per_file("Severance", 2, 3, 902, upgrade=True, quality="WEBDL-2160p"))
        self.assertEqual((up.kind, up.text, up.kind_word), ("file", "Episode Upgraded: Severance S02E03, now 4K",
                                                            "upgrade"))
        done = library_lines.translate("sonarr", complete("The Bear", 3, range(1, 9), range(701, 709)))
        self.assertEqual(done.kind, "complete")
        self.assertEqual(done.text, "Episodes Added: The Bear S03 (8)")
        self.assertEqual(done.upgrade_text, "Episodes Upgraded: The Bear S03 (8), now 1080p")
        self.assertEqual(done.key, "sonarr:complete:abc123hash")
        self.assertEqual(done.file_keys, tuple(f"sonarr:file:{i}" for i in sorted(str(n) for n in range(701, 709))))

    def test_episode_codes_and_counts(self):
        across = library_lines.translate("sonarr", sonarr("Grab", "The Bear", [episode(1, 1), episode(2, 1)] +
                                                          [episode(3, n) for n in range(1, 11)]))
        self.assertEqual(across.text, "Episodes Downloading: The Bear (12)")
        none = library_lines.translate("sonarr", sonarr("Grab", "The Bear", []))
        self.assertEqual(none.text, "Episode Downloading: The Bear")
        dupes = library_lines.translate("sonarr", sonarr("Grab", "Severance", [episode(2, 3), episode(2, 3)]))
        self.assertEqual(dupes.text, "Episode Downloading: Severance S02E03")

    def test_resolution_words(self):
        for quality, word in (("WEBDL-2160p", "4K"), ("Bluray-2160p Remux", "4K"), ("HDTV-1080p", "1080p"),
                              ("WEBRip-720p", "720p"), ("DVD-480p", ""), ("SDTV", ""), (None, ""), (7, "")):
            with self.subTest(quality=quality):
                self.assertEqual(library_lines.resolution(quality), word)
        line = library_lines.translate("radarr", radarr("Download", movieFile=movie_file(quality="DVD"),
                                                        isUpgrade=True))
        self.assertEqual(line.text, "Movie Upgraded: Dune (2021)", "an unknown resolution is left out")

    def test_a_movie_without_a_year(self):
        line = library_lines.translate("radarr", radarr("Grab", movie={"id": 3, "title": "Dune", "year": 0}))
        self.assertEqual(line.text, "Movie Downloading: Dune")

    def test_lines_stay_under_200_characters(self):
        long = "A" * 400
        cases = [("radarr", radarr("Download", movie=movie(long), movieFile=movie_file(), isUpgrade=True)),
                 ("sonarr", per_file(long, 2, 3, 9, upgrade=True, quality="WEBDL-2160p")),
                 ("chaptarr", chaptarr("Grab", books=[book(long)], release={"quality": "EPUB"}))]
        for app, body in cases:
            with self.subTest(app=app):
                text = library_lines.translate(app, body).text
                self.assertLess(len(text), 200)
                self.assertIn("…", text)
        movie_line = library_lines.translate(*cases[0]).text
        self.assertTrue(movie_line.endswith("… (2021), now 4K"), "the title is cut, never the year or resolution")
        self.assertTrue(library_lines.translate(*cases[1]).text.endswith("… S02E03, now 4K"))

    def test_titles_are_one_clean_line(self):
        line = library_lines.translate("radarr", radarr("MovieAdded", movie=movie("Dune\n\tPart\x00 Two", 2024)))
        self.assertEqual(line.text, "Movie Monitored: Dune Part Two (2024)")

    def test_a_book_of_unknown_format_is_a_book(self):
        line = library_lines.translate("chaptarr", chaptarr("Grab", author=author(path="/books/F"), books=[book()],
                                                            release={"quality": "Unknown"}))
        self.assertEqual(line.text, "Book Downloading: Dune Messiah")

    def test_privacy_no_requester_path_or_release_name(self):
        for row, app, body, line, _ in ROWS:
            event = library_lines.translate(app, body)
            if event is None:
                continue
            for text in (event.text, event.upgrade_text):
                for private in PRIVATE:
                    with self.subTest(row=row, private=private):
                        self.assertNotIn(private, text)

    def test_event_names_in_any_case(self):
        self.assertEqual(library_lines.translate("radarr", radarr("moviedelete", deletedFiles=True)).text,
                         "Movie Removed: Dune (2021)")

    def test_any_json_makes_no_line_and_never_raises(self):
        shapes = [None, 1, "x", [], [1], {}, {"eventType": None}, {"eventType": 5}, {"eventType": ["Grab"]},
                  {"eventType": "Grab"}, {"eventType": "Grab", "movie": []}, {"eventType": "Grab", "movie": "x"},
                  {"eventType": "Grab", "movie": {"title": 5, "year": "2021"}},
                  {"eventType": "Download", "series": {"title": "X"}, "episodeFiles": "x", "episodes": "x"},
                  {"eventType": "Download", "series": {"title": "X"}, "episodeFiles": [None, 5, {"id": True}]},
                  {"eventType": "Download", "series": {"title": "X"}, "episodes": [{"seasonNumber": True}]},
                  {"eventType": "Grab", "books": [None, {"title": ""}]},
                  {"eventType": "BookFileDelete", "book": {"title": "B"}, "bookFile": [], "author": None},
                  {"eventType": "Download", "book": {"title": "B"}, "bookFiles": {"0": 1}}]
        for app in library_lines.APPS + ("lidarr",):
            for body in shapes:
                with self.subTest(app=app, body=body):
                    event = library_lines.translate(app, body)
                    if event is not None:
                        self.assertIsInstance(event.text, str)
                        self.assertLess(len(event.text), 200)
        self.assertIsNone(library_lines.translate("lidarr", radarr("Grab")))

    def test_keys_are_per_app_event_and_id(self):
        self.assertEqual(library_lines.translate("radarr", radarr("Grab", downloadId="ABC")).key, "radarr:grab:ABC")
        self.assertEqual(library_lines.translate("radarr", radarr("Download", movieFile=movie_file(5))).key,
                         "radarr:download:5")
        self.assertEqual(library_lines.translate("sonarr", sonarr("SeriesAdd")).key, "sonarr:seriesadd:21")
        self.assertIsNone(library_lines.translate("sonarr", sonarr("Rename")).key, "a rename has no id of its own")
        self.assertIsNone(library_lines.translate("radarr", radarr("Grab")).key, "no download id, no key")
        manual = library_lines.translate("sonarr", complete("X", 1, [1, 2], [4, 3], download=None))
        self.assertEqual(manual.key, "sonarr:complete:files-3-4", "an untracked import is keyed by its files")
        odd = library_lines.translate("radarr", radarr("Grab", downloadId="a b"))
        self.assertIsNone(odd.key, "an id that isn't a plain token is not used")


# --- 2. Storage: Sonarr grouping, leftovers, idempotency ---------------------------------

@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Grouping(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.now = T0
        for p in (mock.patch.object(poller, "SessionLocal", self.Session),
                  mock.patch.object(status_feed, "now_utc", lambda: self.now)):
            p.start()
            self.addCleanup(p.stop)

    def post(self, app, body, minutes=0):
        self.now += timedelta(minutes=minutes)
        event = library_lines.translate(app, body)
        db = self.Session()
        try:
            return status_feed.record_library_event(db, app, event, self.now)
        finally:
            db.close()

    def shown(self):
        db = self.Session()
        try:
            return [i["text"] for i in status_feed.feed(db, 30, self.now)["items"]]
        finally:
            db.close()

    def held(self):
        db = self.Session()
        try:
            return db.query(StatusUpdate).filter(StatusUpdate.pending.is_(True)).count()
        finally:
            db.close()

    def tidy(self, minutes):
        self.now += timedelta(minutes=minutes)
        poller.tidy_library_lines()

    def test_a_season_pack_is_one_line(self):
        for n in range(1, 9):
            self.post("sonarr", per_file("The Bear", 3, n, 700 + n))
        self.assertEqual(self.shown(), [], "per-file imports are held back")
        self.assertEqual(self.held(), 8)
        self.post("sonarr", complete("The Bear", 3, range(1, 9), range(701, 709)), minutes=1)
        self.assertEqual(self.shown(), ["Episodes Added: The Bear S03 (8)"])
        self.assertEqual(self.held(), 0, "the Import Complete took every held file")
        self.tidy(30)
        self.assertEqual(self.shown(), ["Episodes Added: The Bear S03 (8)"], "nothing left over to publish")

    def test_a_single_episode(self):
        self.post("sonarr", per_file("Severance", 2, 3, 901))
        self.post("sonarr", complete("Severance", 2, [3], [901], download="dl-1"))
        self.assertEqual(self.shown(), ["Episode Added: Severance S02E03"])

    def test_an_upgrade_in_a_pack_makes_it_upgraded(self):
        for n in range(1, 4):
            self.post("sonarr", per_file("The Bear", 3, n, 700 + n, upgrade=(n == 2), quality="WEBDL-2160p"))
        self.post("sonarr", complete("The Bear", 3, [1, 2, 3], [701, 702, 703], quality="WEBDL-2160p"))
        self.assertEqual(self.shown(), ["Episodes Upgraded: The Bear S03 (3), now 4K"])

    def test_import_complete_unticked_publishes_each_file_after_ten_minutes(self):
        self.post("sonarr", per_file("Severance", 2, 3, 901))
        self.post("sonarr", per_file("Severance", 2, 4, 902, upgrade=True, quality="Bluray-1080p"), minutes=2)
        self.tidy(9)
        self.assertEqual(self.shown(), ["Episode Added: Severance S02E03"], "the first waited 11 minutes")
        self.tidy(2)
        self.assertEqual(self.shown(), ["Episode Upgraded: Severance S02E04, now 1080p",
                                        "Episode Added: Severance S02E03"])
        self.assertEqual(self.held(), 0)
        self.tidy(5)
        self.assertEqual(len(self.shown()), 2, "published once")

    def test_import_complete_without_held_files_still_writes_its_line(self):
        self.post("sonarr", complete("The Bear", 3, range(1, 9), range(701, 709)))
        self.assertEqual(self.shown(), ["Episodes Added: The Bear S03 (8)"])

    def test_import_complete_takes_only_its_own_files(self):
        self.post("sonarr", per_file("Severance", 2, 3, 901, download="other"))
        self.post("sonarr", per_file("The Bear", 3, 1, 701))
        self.post("sonarr", complete("The Bear", 3, [1], [701]))
        self.assertEqual(self.shown(), ["Episode Added: The Bear S03E01"])
        self.assertEqual(self.held(), 1)

    def test_every_event_is_written_once(self):
        body = radarr("Grab", release=release(), downloadId="abc123hash")
        self.assertTrue(self.post("radarr", body))
        self.assertFalse(self.post("radarr", body), "a repeat of the same grab")
        self.assertTrue(self.post("sonarr", per_file("Severance", 2, 3, 901)))
        self.assertFalse(self.post("sonarr", per_file("Severance", 2, 3, 901)))
        pack = complete("Severance", 2, [3], [901])
        self.assertTrue(self.post("sonarr", pack))
        self.assertFalse(self.post("sonarr", pack))
        self.assertEqual(self.shown(), ["Episode Added: Severance S02E03", "Movie Downloading: Dune (2021)"])
        self.assertTrue(self.post("sonarr", sonarr("Rename", "The Bear")))
        self.assertTrue(self.post("sonarr", sonarr("Rename", "The Bear")), "no id, so a rename is never folded")

    def test_lines_older_than_thirty_days_are_deleted_and_nothing_else(self):
        self.post("radarr", radarr("MovieAdded"))
        db = self.Session()
        db.add(StatusUpdate(source="admin", title="Old note", message="Old note", update_type="note",
                            severity="info", author_id="", author_name="", active=False, created_at=self.now))
        db.commit()
        db.close()
        self.tidy(60 * 24 * 30 - 1)
        db = self.Session()
        self.assertEqual(db.query(StatusUpdate).count(), 2)
        db.close()
        self.tidy(2)
        db = self.Session()
        self.assertEqual([r.source for r in db.query(StatusUpdate).all()], ["admin"])
        db.close()


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class OnceAcrossWorkers(unittest.TestCase):
    """The other worker writes the same event between this one's read and its
    commit: the unique event key decides, and nothing is half-written."""

    def setUp(self):
        from sqlalchemy import create_engine, event
        from app.database import Base
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        url = f"sqlite:///{os.path.join(tmp.name, 'feed.db')}"
        self.mine = create_engine(url)
        self.other = create_engine(url)
        for engine in (self.mine, self.other):
            self.addCleanup(engine.dispose)
        Base.metadata.create_all(bind=self.mine)
        self.event = event

    def race(self, prefix, app, body):
        raced = []

        def hook(conn, cursor, statement, parameters, context, executemany):
            if statement.startswith(prefix) and not raced:
                raced.append(statement)
                db2 = sessionmaker(bind=self.other)()
                try:
                    status_feed.record_library_event(db2, app, library_lines.translate(app, body), T0)
                finally:
                    db2.close()
        self.event.listen(self.mine, "before_cursor_execute", hook)
        self.addCleanup(self.event.remove, self.mine, "before_cursor_execute", hook)
        return raced

    def record(self, app, body):
        db = sessionmaker(bind=self.mine)()
        try:
            return status_feed.record_library_event(db, app, library_lines.translate(app, body), T0)
        finally:
            db.close()

    def rows(self):
        db = sessionmaker(bind=self.mine)()
        try:
            return [(r.message, r.pending) for r in db.query(StatusUpdate).order_by(StatusUpdate.id)]
        finally:
            db.close()

    def test_a_line_is_written_once(self):
        body = radarr("Download", movieFile=movie_file(), isUpgrade=False)
        raced = self.race("INSERT INTO status_updates", "radarr", body)
        self.assertFalse(self.record("radarr", body))
        self.assertEqual(len(raced), 1)
        self.assertEqual(self.rows(), [("Movie Added: Dune (2021)", False)])

    def test_a_held_file_is_held_once(self):
        body = per_file("Severance", 2, 3, 901)
        self.race("INSERT INTO status_updates", "sonarr", body)
        self.assertFalse(self.record("sonarr", body))
        self.assertEqual(self.rows(), [("Episode Added: Severance S02E03", True)])

    def test_an_import_complete_is_written_once_and_takes_its_files_once(self):
        for n in (1, 2):
            self.record("sonarr", per_file("The Bear", 3, n, 700 + n))
        pack = complete("The Bear", 3, [1, 2], [701, 702])
        # Between this worker's read of the held files and its first write.
        raced = self.race("DELETE FROM status_updates", "sonarr", pack)
        self.assertFalse(self.record("sonarr", pack), "the other worker wrote it first")
        self.assertEqual(len(raced), 1)
        self.assertEqual(self.rows(), [("Episodes Added: The Bear S03 (2)", False)])


# --- 3. Library lines stay out of pins, pushes and state, but show the log -------------

@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class NeverAnOutage(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.now = T0
        db = self.Session()
        for app, body in (("radarr", radarr("Grab", release=release(), downloadId="abc123hash")),
                          ("sonarr", sonarr("SeriesDelete", "The Bear", deletedFiles=True)),
                          ("chaptarr", chaptarr("Download", book=book(), bookFiles=[book_file()]))):
            status_feed.record_library_event(db, app, library_lines.translate(app, body), T0)
        db.close()

    def test_not_pinned_and_no_state(self):
        db = self.Session()
        try:
            body = status_feed.feed(db, 30, T0 + timedelta(minutes=1))
            self.assertEqual(body["open"], [])
            self.assertEqual([i["source"] for i in body["items"]], ["library"] * 3)
            self.assertEqual(status_feed.state(True, True, body["open"]), "ok")
        finally:
            db.close()

    def test_never_pushed(self):
        db = self.Session()
        try:
            self.assertEqual(status_feed.due_pushes(db, T0 + timedelta(days=1)), [])
        finally:
            db.close()
        r = FakeRedis()
        r.store[status_feed.KUMA_OK_KEY] = b"1"
        sent = mock.AsyncMock()
        with mock.patch.object(poller, "SessionLocal", self.Session), \
                mock.patch.object(poller, "send_push_to_users", sent), \
                mock.patch.object(status_feed, "now_utc", lambda: T0 + timedelta(days=1)):
            self.assertEqual(asyncio.run(poller.push_status_updates(r)), 0)
        sent.assert_not_awaited()

    def test_without_uptime_kuma_library_lines_alone_show_the_log_and_are_never_down(self):
        db = self.Session()
        try:
            self.assertFalse(status_feed.home_off(db, T0 + timedelta(hours=1)))
            open_items = status_feed.feed(db, 30, T0 + timedelta(hours=1))["open"]
        finally:
            db.close()
        self.assertEqual(status_feed.state(False, False, open_items), "off")
        self.assertEqual(status_feed.state(True, True, open_items), "ok")

    def test_without_uptime_kuma_nothing_to_show_leaves_it_hidden(self):
        db = helpers.make_sessionmaker()()
        try:
            self.assertTrue(status_feed.home_off(db, T0))
        finally:
            db.close()
        db = self.Session()
        try:
            self.assertTrue(status_feed.home_off(db, T0 + timedelta(days=31)), "past the feed's window")
        finally:
            db.close()

    def test_the_feed_item(self):
        db = self.Session()
        try:
            items = status_feed.feed(db, 30, T0 + timedelta(minutes=1))["items"]
        finally:
            db.close()
        grab = next(i for i in items if i["text"].startswith("Movie"))
        self.assertEqual({k: grab[k] for k in ("source", "text", "note", "important", "service")},
                         {"source": "library", "text": "Movie Downloading: Dune (2021)", "note": "not guaranteed",
                          "important": False, "service": None})
        self.assertEqual(grab["at"], "2026-10-05T12:00:00.000Z")
        self.assertEqual({i["note"] for i in items if i is not grab}, {""})

    def test_members_read_them_in_the_feed_and_the_status_summary_ignores_them(self):
        for p in (mock.patch("app.routers.setup.is_setup_completed", return_value=True),
                  mock.patch.object(status_feed, "now_utc", lambda: T0 + timedelta(minutes=1)),
                  mock.patch("app.auth.session_manager.get_redis", mock.AsyncMock(return_value=FakeRedis()))):
            p.start()
            self.addCleanup(p.stop)
        client = helpers.api_client(self.Session, helpers.MEMBER)
        self.addCleanup(helpers.reset_overrides)
        r = client.get("/api/status/feed")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual((body["state"], body["open"]), ("off", []))
        self.assertEqual([i["source"] for i in body["items"]], ["library"] * 3)
        with mock.patch("app.integrations.uptime_kuma.read_monitors",
                        mock.AsyncMock(return_value=[{"id": 1, "name": "Plex", "status": "up"}])):
            summary = client.get("/api/integrations/status-summary").json()
        self.assertEqual(summary, {"status": "online", "down_service": None})


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class HomeHintMatchesThePage(unittest.TestCase):
    """Without Uptime Kuma, the hidden attribute Home is served with
    (main._event_log_off) and home.js's rule on the feed it then reads (hide
    only an "off" answer with no events) agree, so the section never appears
    or vanishes after the first paint. home_event_log.mjs runs the page's
    side on the same answers."""

    NOW = T0 + timedelta(hours=1)

    def served_and_read(self, rows):
        from app import main
        from app.tests.test_pages import render, static_text
        Session = helpers.make_sessionmaker()
        db = Session()
        for row in rows:
            db.add(row)
        db.commit()
        db.close()
        for p in (mock.patch.object(main, "SessionLocal", Session),
                  mock.patch("app.routers.setup.is_setup_completed", return_value=True),
                  mock.patch.object(status_feed, "now_utc", lambda: self.NOW),
                  mock.patch("app.auth.session_manager.get_redis", mock.AsyncMock(return_value=FakeRedis()))):
            p.start()
            self.addCleanup(p.stop)
        page = render(name="index", page=static_text("index.html"), flags={"feed_off": main._event_log_off()})
        client = helpers.api_client(Session, helpers.MEMBER)
        self.addCleanup(helpers.reset_overrides)
        answer = client.get("/api/status/feed").json()
        served_hidden = '<section id="homeEventLog" hidden' in page
        page_hides = answer["state"] == "off" and not answer["open"] and not answer["items"]
        return served_hidden, page_hides, answer["state"]

    def library(self, at):
        return StatusUpdate(source="library", app="radarr", event_key=f"radarr:test:{at}", title="Movie Added: Dune",
                            message="Movie Added: Dune", update_type="import", severity="info", author_id="",
                            author_name="", active=False, important=False, pending=False, created_at=at)

    def test_the_two_agree(self):
        note = StatusUpdate(source="admin", title="Hello", message="Hello", update_type="note", severity="info",
                            author_id="", author_name="", active=True, created_at=T0)
        for what, rows, hidden in (("nothing", [], True),
                                   ("library lines only", [self.library(T0)], False),
                                   ("a note only", [note], False),
                                   ("library lines past the window", [self.library(T0 - timedelta(days=31))], True)):
            with self.subTest(what):
                served_hidden, page_hides, state = self.served_and_read(rows)
                self.assertEqual(state, "off")
                self.assertEqual(served_hidden, hidden)
                self.assertEqual(page_hides, served_hidden)


# --- 4. POST /api/webhooks/{app} ---------------------------------------------------------

@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class Endpoint(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        db = self.Session()
        for app, secret in SECRETS.items():
            helpers.put(db, f"integration.{app}.webhook_secret", secret)
        db.close()
        for patcher in (mock.patch("app.integrations.config.SessionLocal", self.Session),
                        mock.patch("app.routers.setup.is_setup_completed", return_value=True),
                        mock.patch.object(status_feed, "now_utc", lambda: T0)):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.client = helpers.api_client(self.Session)
        self.addCleanup(helpers.reset_overrides)
        # Chaptarr's import also refreshes the Books catalog; that is test_book_catalog's business.
        self.after_import = mock.AsyncMock()
        patcher = mock.patch("app.routers.chaptarr_webhook._after_import", self.after_import)
        patcher.start()
        self.addCleanup(patcher.stop)

    def post(self, app, body=None, password="", raw=None):
        password = SECRETS.get(app, "x") if password == "" else password
        headers = {}
        if password is not None:
            headers["Authorization"] = "Basic " + base64.b64encode(f"{app}:{password}".encode()).decode()
        if raw is not None:
            return self.client.post(f"/api/webhooks/{app}", content=raw, headers=headers)
        return self.client.post(f"/api/webhooks/{app}", json=body, headers=headers)

    def lines(self):
        db = self.Session()
        try:
            return [i["text"] for i in status_feed.feed(db, 30, T0)["items"]]
        finally:
            db.close()

    def test_each_row_over_http(self):
        for row, app, body, line, _ in ROWS:
            with self.subTest(row=row):
                db = self.Session()
                db.query(StatusUpdate).delete()
                db.commit()
                db.close()
                r = self.post(app, body)
                self.assertEqual(r.status_code, 204, r.text)
                self.assertEqual(r.content, b"")
                self.assertEqual(self.lines(), [line] if line else [])

    def test_a_season_pack_over_http(self):
        for n in range(1, 9):
            self.assertEqual(self.post("sonarr", per_file("The Bear", 3, n, 700 + n)).status_code, 204)
        self.assertEqual(self.post("sonarr", complete("The Bear", 3, range(1, 9), range(701, 709))).status_code, 204)
        self.assertEqual(self.lines(), ["Episodes Added: The Bear S03 (8)"])

    def test_each_app_has_its_own_secret(self):
        body = radarr("MovieAdded")
        self.assertEqual(self.post("radarr", body, password=SECRETS["sonarr"]).status_code, 401)
        self.assertEqual(self.post("sonarr", sonarr("SeriesAdd"), password=SECRETS["radarr"]).status_code, 401)
        self.assertEqual(self.post("chaptarr", chaptarr("AuthorDelete"), password=SECRETS["radarr"]).status_code, 401)
        self.assertEqual(self.post("radarr", body, password=None).status_code, 401)
        r = self.post("radarr", body, password="wrong")
        self.assertEqual(r.headers.get("www-authenticate"), 'Basic realm="webhook"')
        self.assertEqual(self.lines(), [])
        self.assertEqual(self.post("radarr", body).status_code, 204)
        self.assertEqual(self.lines(), ["Movie Monitored: Dune (2021)"])

    def test_an_empty_secret_refuses_every_call(self):
        db = self.Session()
        helpers.put(db, "integration.sonarr.webhook_secret", "")
        db.close()
        self.assertEqual(self.post("sonarr", sonarr("SeriesAdd"), password="").status_code, 401)
        self.assertEqual(self.post("sonarr", sonarr("SeriesAdd"), password=None).status_code, 401)
        self.assertEqual(self.lines(), [])

    def test_an_app_not_listed_is_404(self):
        for app in ("lidarr", "Sonarr", "x" * 40):
            with self.subTest(app=app):
                self.assertEqual(self.post(app, {"eventType": "Grab"}, password="x").status_code, 404)

    def test_a_body_that_is_not_json_is_422(self):
        for raw in (b"not json", b"\xff\xfe", b""):
            with self.subTest(raw=raw):
                self.assertEqual(self.post("sonarr", raw=raw).status_code, 422)

    def test_never_a_500(self):
        shapes = [[], "x", 5, None, {"eventType": {"a": 1}}, {"eventType": "Download", "series": [1]},
                  {"eventType": "Grab", "movie": {"title": ["x"]}}, {"eventType": "BookDelete", "book": "x"},
                  json.loads("[" * 50 + "]" * 50)]
        for app in SECRETS:
            for body in shapes:
                with self.subTest(app=app, body=body):
                    self.assertEqual(self.post(app, raw=json.dumps(body).encode()).status_code, 204)
        deep = b"[" * 100000 + b"]" * 100000
        self.assertIn(self.post("radarr", raw=deep).status_code, (204, 422))

    def test_a_database_that_cannot_be_written_is_a_503(self):
        from sqlalchemy.exc import OperationalError
        boom = mock.Mock(side_effect=OperationalError("INSERT", {}, Exception("database is locked")))
        with mock.patch.object(status_feed, "record_library_event", boom):
            self.assertEqual(self.post("radarr", radarr("MovieAdded")).status_code, 503)

    def test_unknown_events_are_logged_without_the_body(self):
        with self.assertLogs("app.routers.chaptarr_webhook", level="INFO") as logs:
            self.post("radarr", radarr("Rename"))
        self.assertIn("radarr", logs.output[0])
        self.assertNotIn("Dune", "\n".join(logs.output))
        self.assertNotIn("/data/media", "\n".join(logs.output))

    def test_chaptarr_imports_still_refresh_the_catalog(self):
        r = self.post("chaptarr", chaptarr("Download", book=book(), bookFiles=[book_file()], isUpgrade=False))
        self.assertEqual(r.status_code, 204)
        self.after_import.assert_awaited_once()
        self.assertEqual(self.lines(), ["Audiobook Added: Dune Messiah"])
        for app, body in (("sonarr", per_file("Severance", 2, 3, 1)), ("radarr", radarr("Download", isUpgrade=False))):
            self.post(app, body)
        self.post("chaptarr", chaptarr("Grab", books=[book()], release={"quality": "M4B"}))
        self.after_import.assert_awaited_once()

    def test_the_rate_limit_is_per_app_and_roomy(self):
        from limits.storage import MemoryStorage
        from limits.strategies import FixedWindowRateLimiter
        from app.limiter import limiter
        saved = (limiter._storage, limiter._limiter)
        storage = MemoryStorage()
        limiter._storage, limiter._limiter = storage, FixedWindowRateLimiter(storage)
        try:
            limiter.reset()
            helpers.set_rate_limits(True)
            codes = [self.post("sonarr", sonarr("Test")).status_code for _ in range(601)]
            self.assertEqual(codes[:600], [204] * 600, "a full-series import fits")
            self.assertEqual(codes[600], 429)
            self.assertEqual(self.post("radarr", radarr("Test")).status_code, 204, "Radarr has its own budget")
            self.assertEqual(self.post("chaptarr", chaptarr("Test")).status_code, 204)
        finally:
            limiter.reset()
            limiter._storage, limiter._limiter = saved
            helpers.set_rate_limits(False)


if __name__ == "__main__":
    unittest.main()
