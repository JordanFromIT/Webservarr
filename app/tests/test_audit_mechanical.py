"""
The mechanical findings of the AI-giveaways audit (2026-10-04), kept fixed.

Each class below names the finding it guards. They read the shipped files
(and, for the welcome post, run the migration against a scratch database), so
a regression shows up here rather than in the next audit.

Home (index.html, pages/home.js) and the shell (partials, shell.js, the nav in
app/pages.py) are being rebuilt separately; they are left out by name below
and their findings are carried by that work.
"""
import re
import unittest
from pathlib import Path

try:
    from app.tests import helpers
    from app import seed
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False

STATIC = Path(__file__).resolve().parents[1] / "static"

# Rebuilt elsewhere (Home and the shell); not judged here.
DEFERRED = {"index.html", "js/pages/home.js", "js/shell.js", "partials/shell-sidebar.html",
            "partials/shell-header.html", "partials/shell-brand.html"}


def read(rel: str) -> str:
    return (STATIC / rel).read_text(encoding="utf-8")


def static_files():
    for path in sorted(STATIC.rglob("*")):
        rel = path.relative_to(STATIC).as_posix()
        if path.suffix not in (".js", ".html") or rel in DEFERRED or rel.startswith("css/"):
            continue
        yield rel, path.read_text(encoding="utf-8")


def js_strings(src: str):
    """Every string and template literal in a script, comments skipped.

    A small scanner, not a parser: it knows comments, the three quote kinds
    and enough about regular expression literals not to read a quote inside
    one as the start of a string."""
    out, i, n = [], 0, len(src)
    prev = ""   # the last significant character, to tell / (divide) from /regex/
    while i < n:
        c = src[i]
        if src.startswith("//", i):
            i = src.find("\n", i)
            i = n if i < 0 else i
            continue
        if src.startswith("/*", i):
            i = src.find("*/", i + 2)
            i = n if i < 0 else i + 2
            continue
        if c in "'\"`":
            j, buf = i + 1, []
            while j < n and src[j] != c:
                if src[j] == "\\":
                    buf.append(src[j:j + 2])
                    j += 2
                    continue
                buf.append(src[j])
                j += 1
            out.append("".join(buf))
            i, prev = j + 1, c
            continue
        if c == "/" and (prev == "" or prev in "(,=:[!&|?{};+-*%<>~^"):
            j, in_class = i + 1, False
            while j < n and src[j] != "\n":
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == "[":
                    in_class = True
                elif src[j] == "]":
                    in_class = False
                elif src[j] == "/" and not in_class:
                    break
                j += 1
            i, prev = j + 1, "/"
            continue
        if not c.isspace():
            prev = c
        i += 1
    return out


DASHES = re.compile(r"[–—]|&[mn]dash;|&#821[12];|&#x201[34];|\\u201[34]", re.I)


def user_text(rel: str, src: str):
    """What a page can show: string literals in scripts, and in HTML the
    markup outside comments, styles and scripts (plus the scripts' strings)."""
    if rel.endswith(".js"):
        return js_strings(src)
    body = re.sub(r"<!--.*?-->", "", src, flags=re.S)
    parts = []
    for script in re.findall(r"<script\b[^>]*>(.*?)</script>", body, flags=re.S):
        parts.extend(js_strings(script))
    body = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", "", body, flags=re.S)
    parts.append(body)
    return parts


class NoDashesInCopy(unittest.TestCase):
    """H5: the em and en dash are out of every string a person can read."""

    def test_the_scanner_finds_strings_and_skips_comments(self):
        found = js_strings("var a = 'x — y'; // c — d\n/* e — */ var r = /'/; var b = `t`;")
        self.assertEqual(found, ["x — y", "t"])

    def test_no_dash_in_any_string_or_page_text(self):
        hits = []
        for rel, src in static_files():
            for text in user_text(rel, src):
                for m in DASHES.finditer(text):
                    hits.append(f"{rel}: ...{text[max(0, m.start() - 30):m.end() + 30]!r}")
        self.assertEqual(hits, [], "\n".join(hits))


class TypeFloorAndSentenceCase(unittest.TestCase):
    """H4 and M4: nothing under 12px, no tracked caps labels, and the pages
    the audit named use the contract's named steps, not pixel literals."""

    def test_nothing_below_twelve_pixels(self):
        tiny = re.compile(r"text-\[(?:[0-9]|1[01])(?:\.\d+)?px\]|font-size:\s*(?:[0-9]|1[01])px")
        hits = [f"{rel}: {m.group(0)}" for rel, src in static_files() for m in tiny.finditer(src)]
        self.assertEqual(hits, [], "\n".join(hits))

    def test_no_uppercase_labels(self):
        # The settings hex field is a colour code. (The login's faked Plex
        # wordmark went with the card's restyle, M7.)
        allowed = {("js/settings/kit.js", 1)}
        counts = {}
        for rel, src in static_files():
            n = len(re.findall(r"(?<![-\w:])uppercase(?![-\w])", src)) + \
                len(re.findall(r"text-transform:\s*uppercase", src))
            if n:
                counts[(rel, n)] = True
        self.assertEqual(set(counts) - allowed, set())

    def test_the_audited_pages_use_the_named_scale(self):
        pages = ("requests.html", "js/pages/requests.js", "issues.html", "js/pages/issues.js",
                 "tickets.html", "js/pages/tickets.js", "calendar.html", "js/pages/calendar.js",
                 "news.html", "js/pages/news.js")
        literal = re.compile(r"(?<![\w-])text-\[(?:8|9|10|11|12|14|16|18|22|26|28)px\]")
        for rel in pages:
            self.assertEqual(literal.findall(read(rel)), [], rel)
        config_file = STATIC.parents[1] / "tailwind.config.js"
        if not config_file.exists():
            return      # the container mounts app/ only; CI and a checkout have the config
        config = config_file.read_text(encoding="utf-8")
        for step, px in (("label", 13), ("body", 15), ("lead", 17), ("h3", 20), ("h2", 24), ("h1", 32)):
            self.assertIn(f'"{step}": "{px}px"', config)
        for step, px in (("card", 16), ("inner", 12), ("btn", 10)):
            self.assertIn(f'"{step}": "{px}px"', config)


class NoGlassOnFlatContent(unittest.TestCase):
    """M1: blur only on real overlays. The calendar's day panel overlays the
    grid; the login card sits on artwork (its own finding, M7)."""

    def test_glass_only_where_something_is_behind_it(self):
        for rel in ("issues.html", "js/pages/issues.js", "tickets.html", "js/pages/tickets.js",
                    "requests.html", "js/pages/requests.js", "js/pages/news.js"):
            self.assertNotIn("glass-card", read(rel), rel)
        cal = read("calendar.html")
        self.assertEqual(cal.count("glass-card"), 1)
        self.assertRegex(cal, r'<section id="dayDetailPanel"[^>]*glass-card')


class EveryCardIsAControl(unittest.TestCase):
    """H8: what opens on a click is a button, so it opens from the keyboard;
    hover zoom only on what is a target."""

    def test_cards_are_buttons(self):
        issues = read("js/pages/issues.js")
        self.assertRegex(issues, r"""'<button type="button" class="[^"]*" data-action="view-issue" """)
        self.assertRegex(issues, r"var row = document\.createElement\('button'\);\s*row\.type = 'button';")
        tickets = read("js/pages/tickets.js")
        self.assertRegex(tickets, r"var card = createEl\('button', [^)]*\);\s*card\.type = 'button';\s*card\.setAttribute\('data-action', 'open-ticket'\)")
        cal = read("js/pages/calendar.js")
        self.assertEqual(len(re.findall(r"document\.createElement\('button'\);\s*\w+\.type = 'button';", cal)), 2)
        self.assertIn("aria-label', dayLabel(", cal)
        requests = read("js/pages/requests.js")
        self.assertRegex(requests, r"""'<button type="button" class="flex w-36 shrink-0 flex-col text-left rounded-xl ws-lift group" ' \+\s*'data-action="open-media" """)

    def test_no_clickable_divs_and_no_hover_zoom(self):
        for rel in ("js/pages/issues.js", "js/pages/tickets.js", "js/pages/calendar.js", "js/pages/requests.js"):
            src = read(rel)
            self.assertNotRegex(src, r"<div[^>]*data-action=\"(?:view-issue|open-ticket|open-media|day)\"", rel)
            self.assertNotRegex(src, r"createElement\('div'\);[^;]*;\s*\w+\.setAttribute\('data-action', 'day'\)", rel)
            self.assertNotRegex(src, r"group-hover:scale-1\d\d", rel)


class OneDialog(unittest.TestCase):
    """M5: every overlay on these pages is WSUI.modal's dialog: role, focus in,
    Tab kept inside, Escape, focus back; the lightbox image has its alt."""

    def test_the_helper(self):
        ui = read("js/ui.js")
        body = ui[ui.index("function modal(overlay, opts)"):ui.index("function isDialogOpen()")]
        for token in ("box.setAttribute('role', 'dialog');", "box.setAttribute('aria-modal', 'true');",
                      "stack.push(entry);", "opts.onClose()", "back.focus({ preventScroll: true });"):
            self.assertIn(token, body)
        self.assertIn("modal: modal,", ui)

    def test_every_overlay_uses_it(self):
        for html, js, ids in (("issues.html", "js/pages/issues.js", ["issueModal"]),
                              ("tickets.html", "js/pages/tickets.js", ["createModal", "detailModal", "lightbox"]),
                              ("requests.html", "js/pages/requests.js", ["mediaModal"])):
            page, script = read(html), read(js)
            for oid in ids:
                block = page[page.index(f'id="{oid}"'):]
                self.assertIn("data-dialog-box", block[:block.index("</div>") + 400], oid)
            self.assertIn("WSUI.modal(", script, js)
            # Escape belongs to the dialog stack, not to a page listener.
            self.assertNotRegex(script, r"e\.key\s*[!=]==\s*'Escape'", js)
        self.assertRegex(read("tickets.html"), r'<img id="lightboxImg" src="" alt=""')
        self.assertIn("$('lightboxImg').alt = label || 'Attached image';", read("js/pages/tickets.js"))


class OneFocusRing(unittest.TestCase):
    """M6: one themed ring for every control, and the discover arrows show
    for the keyboard."""

    def test_the_rule(self):
        theme = read("css/theme.css")
        self.assertRegex(theme, r":where\(a\[href\], button, summary, \[role=\"button\"\], \[tabindex\]:not\(\[tabindex=\"-1\"\]\)\):focus-visible \{\s*outline: 2px solid rgb\(var\(--color-text\)\);\s*outline-offset: 2px;")
        self.assertIn(".discover-row-wrapper:focus-within .discover-scroll-btn", read("requests.html"))


class QuietMotion(unittest.TestCase):
    """M11: the healthy dot never moves and the New! flag rests."""

    def test_motion_means_a_change(self):
        theme = read("css/theme.css")
        self.assertNotRegex(theme, r'data-state="ok"\][^{]*::after\s*\{[^}]*animation:\s*ws-ping')
        self.assertIn('#systemStatus[data-state="err"] .ws-status-dot::after '
                      '{ animation: ws-ping 1.4s cubic-bezier(0, 0, .2, 1) 1; }', theme)
        flag = theme[theme.index(".nav-new-badge {"):]
        flag = flag[:flag.index("\n}")]
        self.assertNotIn("infinite", flag)
        self.assertIn("nav-new-throb 1.7s ease-in-out 3 forwards", flag)


class PlainCopy(unittest.TestCase):
    """H7, L1, H5: no product names or console words in what members read on
    these pages, sentence case, and toasts that name what happened."""

    def test_no_vendor_or_setup_blame(self):
        for rel in ("js/pages/requests.js", "js/pages/issues.js", "js/pages/tickets.js", "js/pages/calendar.js",
                    "js/login.js"):
            src = "\n".join(js_strings(read(rel)))
            self.assertNotRegex(src, r"not configured|Is Seerr|Systems Online|Degraded Performance|Issues Detected", rel)

    def test_toasts_and_buttons(self):
        everything = "\n".join(read(r) for r in ("js/pages/requests.js", "js/pages/issues.js",
                                                 "js/pages/tickets.js", "issues.html", "tickets.html", "login.html"))
        for bad in ("successfully", "Comment added!", "Ticket submitted!", "Submit Issue", "Add Comment",
                    "Sign In", "All Types", "In Progress"):
            self.assertFalse(bad in everything, bad)
        self.assertIn("showToast(title ? 'Requested ' + title : 'Requested', 'success');", read("js/pages/requests.js"))

    def test_labels_are_bound(self):
        # M13: every field has a real label; validation is on the field.
        for rel, ids in (("issues.html", ["searchInput", "issueMessage"]),
                         ("tickets.html", ["createTitle", "createCategory", "createDescription", "createImage"]),
                         ("login.html", ["username", "password"]),
                         ("reader.html", ["fontSize", "lineHeight", "measure"])):
            page = read(rel)
            for fid in ids:
                self.assertIn(f'for="{fid}"', page, f"{rel} {fid}")
        for rel in ("js/pages/issues.js", "js/pages/tickets.js"):
            src = read(rel)
            self.assertIn("ws-invalid", src)
            self.assertNotRegex(src, r"showToast\('(?:Please|Title is required|Description is required|Comment cannot)")


class SmallTells(unittest.TestCase):
    """L5, L9, L10, M12: one relative date, no logs, dark pages say so, the
    reader's guide matches its panel, words break only when they must."""

    def test_one_relative_date(self):
        self.assertIn("function getTimeAgo(date, sentence)", read("js/auth.js"))
        for rel in ("js/notifications.js", "js/pages/tickets.js", "js/pages/news.js"):
            src = read(rel)
            self.assertNotRegex(src, r"Math\.floor\(\w+ / 3600\) \+ '[h ]", rel)
            self.assertIn("getTimeAgo(", src, rel)

    def test_no_console_log_and_dark_pages(self):
        for rel in ("js/pages/issues.js", "js/pages/requests.js"):
            self.assertNotIn("console.log(", read(rel), rel)
        for rel in ("login.html", "setup.html"):
            self.assertIn('<html class="dark" lang="en">', read(rel), rel)
        self.assertNotIn("<!-- Footer: System Status -->", read("login.html"))

    def test_no_word_breaks_anywhere(self):
        for rel, src in static_files():
            self.assertNotIn("overflow-wrap:anywhere", src, rel)

    def test_reader(self):
        reader = read("js/pages/reader.js")
        self.assertIn("Tap or click either edge", reader)
        self.assertIn("The five page colours", reader)
        page = read("reader.html")
        self.assertEqual(page.count('class="wsp-range"'), 3)
        self.assertIn('id="columns" type="button" role="switch"', page)
        self.assertNotRegex(reader, r"\+ 'rem'\s*;|\+ 'px';\s*\n\s*el\('lhVal'\)")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class WelcomePost(unittest.TestCase):
    """H6: the seeded welcome post speaks to members, is not pinned, and an
    old untouched copy is rewritten once; an edited one is left alone."""

    def setUp(self):
        self.db = helpers.make_sessionmaker()()

    def tearDown(self):
        self.db.close()

    def post(self, title, content, pinned=True):
        from app.models import NewsPost
        p = NewsPost(title=title, content=content, content_html="<p>x</p>", author_id="system",
                     author_name="WebServarr", published=True, pinned=pinned)
        self.db.add(p)
        self.db.commit()
        return p.id

    def test_a_fresh_install_gets_the_new_post(self):
        from app.models import NewsPost
        seed.seed_default_news(self.db)
        seed.migrate_welcome_post_v2(self.db)
        welcome = self.db.query(NewsPost).filter(NewsPost.title == "Welcome").one()
        self.assertFalse(welcome.pinned)
        for vendor in ("Plex", "Seerr", "Sonarr", "Radarr", "Netdata", "Uptime", "—"):
            self.assertNotIn(vendor, welcome.content)

    def test_the_old_post_is_rewritten_once_and_an_edited_one_is_kept(self):
        from app.models import NewsPost
        old = self.post(seed._OLD_WELCOME_TITLE, seed._OLD_WELCOME_CONTENT)
        edited = self.post(seed._OLD_WELCOME_TITLE, seed._OLD_WELCOME_CONTENT + "\n\nOur own words.")
        seed.migrate_welcome_post_v2(self.db)
        a = self.db.get(NewsPost, old)
        self.assertEqual((a.title, a.content, a.pinned), ("Welcome", seed.WELCOME_POST_CONTENT, False))
        self.assertIn("edit or remove", a.content_html)
        b = self.db.get(NewsPost, edited)
        self.assertEqual((b.title, b.pinned), (seed._OLD_WELCOME_TITLE, True))
        # The marker holds: a post put back afterwards is not touched again.
        again = self.post(seed._OLD_WELCOME_TITLE, seed._OLD_WELCOME_CONTENT)
        seed.migrate_welcome_post_v2(self.db)
        self.assertEqual(self.db.get(NewsPost, again).title, seed._OLD_WELCOME_TITLE)


if __name__ == "__main__":
    unittest.main()
