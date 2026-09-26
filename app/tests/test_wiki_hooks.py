"""
Contextual help links are set from the page editor: a page can be "help on"
Tickets, Issues or Playback. Ticking one moves it from whichever page had it;
renaming a page's address keeps its links; deleting a page clears them.

The links move in the page write's own transaction, so a write that fails
moves none of them, and every value stored meets the Settings rule for a
wiki.hook_* key.
"""
import re
import unittest
from pathlib import Path
from unittest import mock

try:
    from app.tests import helpers
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False

from app.tests.test_shell_contract import js_code_only, live_matches

STATIC = Path(__file__).resolve().parents[1] / "static"


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class WikiHooks(unittest.TestCase):
    def setUp(self):
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()
        self.client = helpers.api_client(self.Session)

    def tearDown(self):
        helpers.reset_overrides()
        self.setup_patch.stop()
        self.db.close()

    def page(self, title, help_on=None, slug=None):
        body = {"title": title, "content": "Some text", "published": True}
        if help_on is not None:
            body["help_on"] = help_on
        if slug:
            body["slug"] = slug
        r = self.client.post("/api/wiki/pages", json=body)
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["slug"]

    def hook(self, name):
        return helpers.get(self.db, "wiki.hook_" + name) or ""

    def hooks(self):
        return (self.hook("tickets"), self.hook("issues"), self.hook("playback"))

    def test_ticking_sets_and_moves_a_hook(self):
        a = self.page("Contact help", ["tickets"])
        self.assertEqual(self.hook("tickets"), a)
        b = self.page("Better contact help", ["tickets", "issues"])
        self.assertEqual(self.hook("tickets"), b)
        self.assertEqual(self.hook("issues"), b)

    def test_update_with_a_list_sets_exactly_those(self):
        a = self.page("Guide", ["tickets", "issues"])
        r = self.client.put(f"/api/wiki/pages/{a}", json={"title": "Guide", "content": "x", "published": True,
                                                          "help_on": ["playback"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((self.hook("tickets"), self.hook("issues"), self.hook("playback")), ("", "", a))

    def test_update_without_help_on_leaves_hooks_alone(self):
        a = self.page("Guide", ["tickets"])
        self.client.put(f"/api/wiki/pages/{a}", json={"title": "Guide", "content": "changed", "published": True})
        self.assertEqual(self.hook("tickets"), a)

    def test_clearing_only_touches_this_pages_hooks(self):
        a = self.page("A", ["tickets"])
        b = self.page("B", ["issues"])
        self.client.put(f"/api/wiki/pages/{a}", json={"title": "A", "content": "x", "published": True, "help_on": []})
        self.assertEqual((self.hook("tickets"), self.hook("issues")), ("", b))

    def test_renaming_the_address_keeps_the_links(self):
        a = self.page("Old name", ["issues"])
        r = self.client.put(f"/api/wiki/pages/{a}", json={"title": "New name", "slug": "new-name",
                                                          "content": "x", "published": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.hook("issues"), "new-name")

    def test_deleting_a_page_clears_its_links(self):
        a = self.page("Doomed", ["playback"])
        self.assertEqual(self.client.delete(f"/api/wiki/pages/{a}").status_code, 204)
        self.assertEqual(self.hook("playback"), "")

    def test_admins_see_who_holds_each_link(self):
        a = self.page("A", ["tickets"])
        b = self.page("B")
        data = self.client.get(f"/api/wiki/pages/{b}").json()
        self.assertEqual(data["help_on"], [])
        self.assertEqual(data["help_holders"]["tickets"], {"title": "A", "slug": "a"})
        self.assertIsNone(data["help_holders"]["issues"])
        self.assertEqual(self.client.get(f"/api/wiki/pages/{a}").json()["help_on"], ["tickets"])
        helpers.reset_overrides()
        member = helpers.api_client(self.Session, helpers.MEMBER)
        self.assertNotIn("help_on", member.get(f"/api/wiki/pages/{a}").json())

    # ---- beyond the brief ----

    def test_members_never_see_the_help_fields(self):
        self.page("A", ["tickets"])
        b = self.page("B")
        helpers.reset_overrides()
        member = helpers.api_client(self.Session, helpers.MEMBER)
        for slug in ("a", b):
            data = member.get(f"/api/wiki/pages/{slug}").json()
            self.assertNotIn("help_on", data)
            self.assertNotIn("help_holders", data)
        self.assertEqual(member.post("/api/wiki/pages", json={"title": "M", "content": "x",
                                                              "help_on": ["tickets"]}).status_code, 403)
        self.assertEqual(self.hook("tickets"), "a")

    def test_the_page_holding_a_link_sees_it_as_its_own(self):
        a = self.page("A", ["tickets", "playback"])
        data = self.client.get(f"/api/wiki/pages/{a}").json()
        self.assertEqual(data["help_on"], ["tickets", "playback"])
        self.assertEqual(data["help_holders"], {"tickets": None, "issues": None, "playback": None})

    def test_holders_are_told_apart_by_address(self):
        # Titles are not unique; the editor keys a holder on its slug.
        self.page("FAQ", slug="faq")
        self.page("FAQ", ["tickets"], slug="faq-2")
        p = self.page("P")
        self.assertEqual(self.client.get(f"/api/wiki/pages/{p}").json()["help_holders"],
                         {"tickets": {"title": "FAQ", "slug": "faq-2"}, "issues": None, "playback": None})

    def test_a_stale_row_at_commit_answers_404(self):
        # Backstop for an edit racing a delete: if the UPDATE finds its row
        # gone at commit, the answer is a plain 404, and nothing moved.
        from sqlalchemy.orm import Session as OrmSession
        from sqlalchemy.orm.exc import StaleDataError
        a = self.page("A", ["tickets"])

        def stale(session):
            raise StaleDataError("UPDATE statement on table 'wiki_pages' expected to update 1 row(s); 0 were matched.")
        with mock.patch.object(OrmSession, "commit", stale):
            r = self.client.put(f"/api/wiki/pages/{a}", json={"title": "A", "content": "y", "published": True,
                                                              "help_on": ["issues"]})
        self.assertEqual((r.status_code, r.json()), (404, {"detail": "That page was deleted."}))
        self.assertEqual(self.hooks(), (a, "", ""))

    def test_a_client_slug_reaches_the_hook_normalised(self):
        # The editor sends whatever is in the Address box. Create and update
        # both run it through slugify, so a hook only ever holds a value the
        # Settings API would accept for that key.
        from app.settings_registry import validate_value
        a = self.page("Messy", ["tickets"], slug="  Help: Tickets & Más!! ")
        self.assertEqual(a, "help-tickets-mas")
        self.assertEqual(self.hook("tickets"), "help-tickets-mas")
        r = self.client.put(f"/api/wiki/pages/{a}", json={"title": "Messy", "slug": "Ünïcode / Path?",
                                                          "content": "x", "published": True, "help_on": ["issues"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["slug"], "unicode-path")
        self.assertEqual(self.hooks(), ("", "unicode-path", ""))
        for name in ("tickets", "issues", "playback"):
            self.assertIsNone(validate_value("wiki.hook_" + name, self.hook(name)))

    def test_a_rename_and_a_new_list_together(self):
        a = self.page("Old", ["tickets"])
        r = self.client.put(f"/api/wiki/pages/{a}", json={"title": "Old", "slug": "fresh", "content": "x",
                                                          "published": True, "help_on": ["issues"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.hooks(), ("", "fresh", ""))

    def test_a_rename_leaves_other_pages_links_alone(self):
        self.page("Other", ["tickets"])
        a = self.page("Mine", ["issues"])
        self.client.put(f"/api/wiki/pages/{a}", json={"title": "Mine", "slug": "mine-2", "content": "x",
                                                      "published": True})
        self.assertEqual(self.hooks(), ("other", "mine-2", ""))

    def test_deleting_a_page_leaves_other_pages_links_alone(self):
        self.page("Keeper", ["tickets"])
        a = self.page("Doomed", ["issues", "playback"])
        self.client.delete(f"/api/wiki/pages/{a}")
        self.assertEqual(self.hooks(), ("keeper", "", ""))

    def test_an_unknown_place_is_refused_and_nothing_moves(self):
        a = self.page("A", ["tickets"])
        b = self.page("B")
        r = self.client.put(f"/api/wiki/pages/{b}", json={"title": "B", "content": "x", "published": True,
                                                          "help_on": ["tickets", "sidebar"]})
        self.assertEqual(r.status_code, 422)
        r = self.client.post("/api/wiki/pages", json={"title": "C", "content": "x", "help_on": ["home"]})
        self.assertEqual(r.status_code, 422)
        self.assertEqual(self.hooks(), (a, "", ""))

    def test_a_write_refused_after_the_hooks_were_worked_out_moves_nothing(self):
        # A missing category is found after the new address is assigned; the
        # request ends without a commit, so neither the page nor a link moved.
        from app.models import WikiPage
        a = self.page("A", ["tickets"])
        b = self.page("B", ["issues"])
        r = self.client.put(f"/api/wiki/pages/{b}", json={"title": "B", "slug": "b-renamed", "content": "x",
                                                          "published": True, "category_slug": "nope",
                                                          "help_on": ["tickets", "issues"]})
        self.assertEqual(r.status_code, 404)
        self.assertEqual(self.hooks(), (a, b, ""))
        self.db.expire_all()
        self.assertIsNotNone(self.db.query(WikiPage).filter(WikiPage.slug == b).first())

    def _failing_commit(self):
        from sqlalchemy.orm import Session as OrmSession

        def boom(session):
            raise RuntimeError("the disk is full")
        return mock.patch.object(OrmSession, "commit", boom)

    def test_a_failed_commit_moves_no_link(self):
        from app.models import WikiPage
        a = self.page("A", ["tickets"])
        b = self.page("B", ["issues"])
        before = self.hooks()
        with self._failing_commit():
            with self.assertRaises(RuntimeError):     # update, with a rename and a new list
                self.client.put(f"/api/wiki/pages/{b}", json={"title": "B", "slug": "b-2", "content": "x",
                                                              "published": True, "help_on": ["tickets", "playback"]})
            with self.assertRaises(RuntimeError):     # create, taking a link
                self.client.post("/api/wiki/pages", json={"title": "C", "content": "x", "published": True,
                                                          "help_on": ["tickets"]})
            with self.assertRaises(RuntimeError):     # delete, clearing one
                self.client.delete(f"/api/wiki/pages/{a}")
        self.assertEqual(self.hooks(), before)
        self.db.expire_all()
        self.assertEqual(sorted(p.slug for p in self.db.query(WikiPage).all()), [a, b])

    def test_each_write_commits_once(self):
        # The links travel in the page write's transaction: one commit per
        # request, so there is no moment where one landed without the other.
        from sqlalchemy.orm import Session as OrmSession
        real = OrmSession.commit
        commits = []

        def counted(session):
            commits.append(1)
            return real(session)
        self.page("A", ["tickets"])
        with mock.patch.object(OrmSession, "commit", counted):
            for call in (
                lambda: self.client.post("/api/wiki/pages", json={"title": "B", "content": "x", "published": True,
                                                                  "help_on": ["issues"]}),
                lambda: self.client.put("/api/wiki/pages/b", json={"title": "B", "slug": "b-2", "content": "y",
                                                                   "published": True, "help_on": ["issues", "playback"]}),
                lambda: self.client.delete("/api/wiki/pages/b-2"),
            ):
                commits.clear()
                r = call()
                self.assertLess(r.status_code, 300, r.text)
                self.assertEqual(len(commits), 1, r.request.method)
        self.assertEqual(self.hooks(), ("a", "", ""))


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class ConcurrentHookWrites(unittest.TestCase):
    """Two page writes at once, as two uvicorn workers send them: each has
    its own connection to a file-backed database. The hook rows are read under
    SQLite's write lock, so the second write waits for the first, decides from
    what it left, and a missing row cannot collide on its key."""

    def setUp(self):
        import tempfile
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker

        from app import models  # noqa: F401 - registers the tables
        from app.database import Base
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = create_engine(f"sqlite:///{self.tmp.name}/race.db",
                                    connect_args={"check_same_thread": False, "timeout": 10})
        Base.metadata.create_all(bind=self.engine)
        self.Session = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)
        self.setup_patch = mock.patch("app.routers.setup.is_setup_completed", return_value=True)
        self.setup_patch.start()
        self.client = helpers.api_client(self.Session)

    def tearDown(self):
        helpers.reset_overrides()
        self.setup_patch.stop()
        self.engine.dispose()
        self.tmp.cleanup()

    def seed(self, pages, hook_rows=True):
        from app.models import Setting, WikiPage
        db = self.Session()
        for slug in pages:
            db.add(WikiPage(title=slug, slug=slug, content="x", content_html="<p>x</p>", published=True,
                            author_name="admin"))
        if hook_rows:
            for name in ("tickets", "issues", "playback"):
                db.add(Setting(key="wiki.hook_" + name, value=""))
        db.commit()
        db.close()

    def set_hooks(self, **values):
        db = self.Session()
        for name, value in values.items():
            helpers.put(db, "wiki.hook_" + name, value)
        db.close()

    def hooks(self):
        db = self.Session()
        try:
            return tuple(helpers.get(db, "wiki.hook_" + n) for n in ("tickets", "issues", "playback"))
        finally:
            db.close()

    def race(self, *calls, after=None):
        """Run two calls on two threads. Each pauses just after it reads the
        hook rows until the other has read them too, or 1.5s pass. Without the
        lock both reads land before either write; with it the second read can
        only happen once the first write has committed, so the pause runs out.
        after={endpoint: seconds} holds that endpoint back a little longer after
        its read, to fix which write lands last."""
        import sys
        import threading
        import time

        import app.routers.wiki as wiki
        barrier = threading.Barrier(2, timeout=1.5)
        real = wiki._hook_rows

        def paused(db):
            rows = real(db)
            try:
                barrier.wait()
            except threading.BrokenBarrierError:
                pass
            # The endpoint runs on the TestClient's event-loop thread, not the
            # one that started the call, so find it on the stack instead.
            frame = sys._getframe(1)
            while frame is not None:
                if frame.f_code.co_name in (after or {}):
                    time.sleep(after[frame.f_code.co_name])
                    break
                frame = frame.f_back
            return rows

        out = [None] * len(calls)

        def run(i, call):
            try:
                out[i] = call()
            except Exception as exc:  # a 500 re-raised by the TestClient
                out[i] = exc
        with mock.patch.object(wiki, "_hook_rows", paused):
            threads = [threading.Thread(target=run, args=(i, c)) for i, c in enumerate(calls)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(30)
        return out

    def put_help(self, slug, help_on):
        return lambda: self.client.put(f"/api/wiki/pages/{slug}", json={"title": slug, "slug": slug, "content": "x",
                                                                        "published": True, "help_on": help_on})

    def test_two_writes_to_one_page_leave_exactly_one_list(self):
        self.seed(["page-a"])
        r1, r2 = self.race(self.put_help("page-a", ["tickets"]), self.put_help("page-a", ["issues"]))
        self.assertEqual([getattr(r, "status_code", r) for r in (r1, r2)], [200, 200])
        self.assertIn(self.hooks(), [("page-a", "", ""), ("", "page-a", "")])

    def test_a_delete_cannot_undo_a_claim_made_meanwhile(self):
        self.seed(["page-a", "page-b"])
        self.set_hooks(tickets="page-a")
        # The delete writes last: deciding from its early read, it would clear
        # the link page-b had just taken.
        r1, r2 = self.race(lambda: self.client.delete("/api/wiki/pages/page-a"), self.put_help("page-b", ["tickets"]),
                           after={"delete_page": 0.3})
        self.assertEqual([getattr(r, "status_code", r) for r in (r1, r2)], [204, 200])
        self.assertEqual(self.hooks(), ("page-b", "", ""))

    def edit_while_deleted(self, body):
        """The edit reads the page, then a delete commits before the edit takes
        the write lock (the hunter's ordering). Returns (edit, delete) responses."""
        import sys
        import threading

        import app.routers.wiki as wiki
        real = wiki._claim_hook_rows
        parked, deleted = threading.Event(), threading.Event()

        def claim(db):
            frame = sys._getframe(1)
            while frame is not None and frame.f_code.co_name not in ("update_page", "delete_page"):
                frame = frame.f_back
            if frame is not None and frame.f_code.co_name == "update_page":
                parked.set()
                deleted.wait(5)
            return real(db)
        out = {}

        def edit():
            try:
                out["edit"] = self.client.put("/api/wiki/pages/dpage", json=body)
            except Exception as exc:  # a 500 re-raised by the TestClient
                out["edit"] = exc

        def delete():
            parked.wait(5)
            out["delete"] = self.client.delete("/api/wiki/pages/dpage")
            deleted.set()
        with mock.patch.object(wiki, "_claim_hook_rows", claim):
            threads = [threading.Thread(target=edit), threading.Thread(target=delete)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(15)
        return out["edit"], out["delete"]

    def test_an_edit_racing_a_delete_answers_404(self):
        # Not a bare 500, and no link moved; the delete cleared the page's own.
        self.seed(["dpage"])
        self.set_hooks(tickets="dpage")
        edit, delete = self.edit_while_deleted({"title": "dpage renamed", "content": "new body", "published": True,
                                                "help_on": ["issues"]})
        self.assertEqual(delete.status_code, 204)
        self.assertEqual(getattr(edit, "status_code", edit), 404)
        self.assertEqual(edit.json(), {"detail": "That page was deleted."})
        self.assertEqual(self.hooks(), ("", "", ""))

    def test_an_edit_that_changes_only_links_racing_a_delete_moves_no_link(self):
        # Same ordering, but the edit changes no page field: no UPDATE of the
        # page is sent, so nothing fails at commit. Only the check made under
        # the lock stops a link being pointed at the deleted page.
        self.seed(["dpage"])
        edit, delete = self.edit_while_deleted({"title": "dpage", "slug": "dpage", "content": "x", "published": True,
                                                "help_on": ["issues"]})
        self.assertEqual(delete.status_code, 204)
        self.assertEqual(getattr(edit, "status_code", edit), 404)
        self.assertEqual(self.hooks(), ("", "", ""))

    def test_a_missing_row_cannot_collide(self):
        # Rows are seeded at startup, but a missing one must not turn two
        # concurrent first claims into a primary-key clash and a 500.
        self.seed([], hook_rows=False)
        post = lambda slug: (lambda: self.client.post("/api/wiki/pages", json={
            "title": slug, "slug": slug, "content": "x", "published": True, "help_on": ["tickets"]}))
        r1, r2 = self.race(post("page-x"), post("page-y"))
        self.assertEqual([getattr(r, "status_code", r) for r in (r1, r2)], [201, 201])
        tickets, issues, playback = self.hooks()
        self.assertIn(tickets, ("page-x", "page-y"))
        self.assertEqual((issues, playback), ("", ""))


def editor_js() -> str:
    return (STATIC / "js" / "wiki-editor.js").read_text(encoding="utf-8")


def function_body(code: str, name: str) -> str:
    from app.tests.test_shell_contract import matching_brace
    m = re.search(r"\bfunction " + re.escape(name) + r"\s*\([^)]*\)\s*\{", code)
    assert m, name
    return code[m.end():matching_brace(code, m.end() - 1)]


class WikiEditorHelp(unittest.TestCase):
    """The editor's "Show as help on" boxes (behaviour is proven by a Node
    harness in the task report; these pin the lines it depends on)."""

    def test_holder_titles_go_in_as_text(self):
        src = editor_js()
        self.assertEqual(len(live_matches(
            src, r"line\.appendChild\(el\('span', '[^']*', '\(now on “' \+ holders\[h\[0\]\]\.title \+ '” — ticking moves it here\)'\)\);")), 1)
        # el() writes its text with textContent; the only innerHTML is the
        # server-sanitised preview.
        self.assertIn("if (text !== undefined && text !== null) n.textContent = text;", js_code_only(src))
        writes = live_matches(src, r"\.innerHTML\s*=(?!=)[^;]*;")
        self.assertEqual([w.group(0) for w in writes], [".innerHTML = page.content_html;"])

    def test_help_on_is_sent_only_when_the_admin_changed_it(self):
        code = js_code_only(editor_js())
        save = function_body(code, "save")
        self.assertIn("help_on: helpKey(fields.help_on) !== helpKey(s.helpBase) ? fields.help_on : null", save)
        self.assertRegex(function_body(code, "helpKey"), r"^\s*return \(list \|\| \[\]\)\.slice\(\)\.sort\(\)\.join\(")
        self.assertEqual(len(live_matches(editor_js(), r"return \(list \|\| \[\]\)\.slice\(\)\.sort\(\)\.join\(','\);")), 1)
        opened = function_body(code, "open")
        self.assertIn("var helpBase = page ? (page.help_on || []).slice() : [];", opened)
        self.assertIn("_session = { slug: _slug, helpBase: helpBase, helpSeen: seenNow, holders: holders, form: null, busy: false };", opened)

    def test_a_restored_draft_replays_a_box_only_where_the_link_has_not_moved(self):
        # Per place: a box the admin changed before leaving is replayed only
        # while that link is where it was then (then[n] === seenNow[n]);
        # otherwise the box shows the link as it is now and the admin is told.
        src = editor_js()
        opened = function_body(js_code_only(src), "open")
        self.assertIn("var holders = helpHolders(page);", opened)
        self.assertIn("var seenNow = helpSeen(helpBase, holders);", opened)
        self.assertRegex(opened, r"var usable = !!then && typeof then === '\s*' && !Array\.isArray\(then\) && Array\.isArray\(f\.help_on\);")
        for line in (r"var n = h\[0\], want = seenNow\[n\] === 'self';",
                     r"if \(ticked !== \(then\[n\] === 'self'\)\) \{\s*if \(then\[n\] === seenNow\[n\]\) want = ticked;\s*else dropped = true;\s*\}",
                     r"initial = Object\.assign\(\{\}, f, \{ help_on: on \}\);",
                     r"if \(dropped\) status\('Your unsaved change to the help links was left out: that link has changed since\.'\);"):
            self.assertEqual(len(live_matches(src, line)), 1, line)
        self.assertIn("fields.help_state = Object.assign({}, s.helpSeen);", function_body(js_code_only(src), "mirror"))
        # Only help_state drafts replay: help_base (round 0) and help_seen
        # (keyed on titles) never do.
        self.assertIn("var f = draft.fields, then = f.help_state;", opened)
        self.assertNotRegex(js_code_only(src), r"\bf\.help_(?:seen|base)\b")

    def test_holders_are_keyed_on_their_address(self):
        # Two pages can share a title, so a holder is compared by slug; the
        # title is only shown.
        src = editor_js()
        self.assertEqual(len(live_matches(
            src, r"seen\[n\] = helpBase\.indexOf\(n\) >= 0 \? 'self' : \(holders\[n\] \? 'page:' \+ holders\[n\]\.slug : ''\);")), 1)
        self.assertNotRegex(js_code_only(src), r"holders\[n\]\.title|'other:'")

    def test_mirror_timers_and_guards(self):
        # (a) a landed save or delete cancels the pending mirror, so no draft
        # reappears for what was just published or deleted; (b) a mirror only
        # writes while its own editor is on screen, so B's fields never land in
        # A's draft; (c) a tick is autosaved like any other edit.
        src = editor_js()
        code = js_code_only(src)
        cancel = "if (_mirrorTimer) { clearTimeout(_mirrorTimer); _mirrorTimer = null; }"
        for name in ("save", "remove", "open"):
            self.assertEqual(function_body(code, name).count(cancel), 1, name)
        save = function_body(code, "save")
        self.assertLess(save.index(cancel), save.index("clearDraft(s.slug);"))
        remove = function_body(code, "remove")
        self.assertLess(remove.index(cancel), remove.index("clearDraft(s.slug);"))
        self.assertRegex(function_body(code, "mirror"),
                         r"var s = _session;\s*_mirrorTimer = setTimeout\(function \(\) \{\s*_mirrorTimer = null;\s*"
                         r"if \(_session !== s\) return;")
        self.assertEqual(len(live_matches(src, r"box\.addEventListener\('change', mirror\);")), 1)

    def test_a_new_page_names_holders_from_the_branding_payload(self):
        src = editor_js()
        code = js_code_only(src)
        holders = function_body(code, "helpHolders")
        self.assertIn("var hooks = (window.WEBSERVARR_THEME && window.WEBSERVARR_THEME.wiki_hooks) || {};", holders)
        self.assertIn("var n = h[0], held = page ? (page.help_holders || {})[n] : hooks[n];", holders)
        self.assertIn("out[n] = held && held.slug ? { slug: held.slug, title: held.title || held.slug } : null;", holders)
        self.assertIn("var holders = _session.holders;", function_body(code, "render"))
        # No extra request: the same five fetches as before (save, remove, page,
        # categories, image upload).
        self.assertEqual(len(re.findall(r"\bfetch\(", code)), 5)
        # A landed write keeps that payload in step; the hint says when the link shows.
        self.assertIn("if (saved) syncHooks(s, saved, payload.help_on);", function_body(code, "save"))
        self.assertIn("syncHooks(s, null, null);", function_body(code, "remove"))
        self.assertRegex(function_body(code, "syncHooks"),
                         r"if \(holds\) hooks\[n\] = saved\.published \? \{ slug: saved\.slug, title: saved\.title \} : null;\s*"
                         r"else if \(mine\) hooks\[n\] = null;")
        self.assertEqual(len(live_matches(src, r"'A link to this page appears above that form once the page is published\. "
                                               r"Only one page can be linked in each place\.'")), 1)

    def test_a_deleted_page_says_so(self):
        # An edit that answers 404 (the page was deleted meanwhile) gets a
        # plain message, keeps the text and draft, and gives the controls back.
        src = editor_js()
        save = function_body(js_code_only(src), "save")
        self.assertRegex(save, r"if \(!res\.ok\) setBusy\(s, false\);")
        self.assertLess(save.index("if (res.status === 404) {"), save.index("if (!res.ok) {"))
        self.assertEqual(len(live_matches(src, r"'This page was deleted while you were editing, so it can’t be saved\. "
                                               r"Your text is still here — copy it before you leave\.'")), 1)

    def test_every_write_clears_the_page_cache(self):
        code = js_code_only(editor_js())
        self.assertRegex(function_body(code, "clearPageCache"), r"^\s*if \(window\.WS && WS\.clearPageCache\) WS\.clearPageCache\(\);\s*$")
        for name in ("save", "remove"):
            body = function_body(code, name)
            fetched = body[body.index("await fetch("):]
            # Once in the network-failure catch, once straight after the answer.
            self.assertEqual(len(re.findall(r"(?<!function )\bclearPageCache\(\);", fetched)), 2, name)
            self.assertRegex(fetched, r"\} catch \(e\) \{\s*(?://[^\n]*\n\s*)*clearPageCache\(\);", name)
            self.assertRegex(fetched, r"\n\s*\}\s*clearPageCache\(\);", name)
        self.assertEqual(len(re.findall(r"\bawait fetch\(", code)), 2 + 3)   # save, remove + 3 reads

    def test_a_write_holds_its_own_form(self):
        code = js_code_only(editor_js())
        for name in ("save", "remove"):
            body = function_body(code, name)
            self.assertRegex(body, r"^\s*var s = _session;\s*if \(!s \|\| s\.busy\) return;", name)
            self.assertIn("setBusy(s, true);", body)
            after = body[body.index("await fetch("):]
            self.assertNotRegex(after, r"\b_slug\b", name)          # the save's own page, not the editor's
        self.assertRegex(function_body(code, "setBusy"),
                         r"^\s*s\.busy = busy;\s*Array\.prototype\.slice\.call\(s\.form\.querySelectorAll\(")
        self.assertEqual(len(live_matches(editor_js(), r"s\.form\.querySelectorAll\('button, input, select, textarea'\)\)\s*"
                                                        r"\.forEach\(function \(n\) \{ n\.disabled = busy; \}\);")), 1)
        save = function_body(code, "save")
        self.assertRegex(save, r"if \(!res\.ok\) setBusy\(s, false\);\s*(?://[^\n]*\n\s*)*if \(_session !== s\) return;")


class WikiEditorDialogs(unittest.TestCase):
    """The editor asks and tells through the site's own dialog and toast
    (window.WSUI, from ui.js), never the browser's confirm/alert, and every
    label names its field."""

    def test_no_native_dialogs(self):
        from app.tests.test_settings_static import NATIVE_DIALOG
        self.assertIsNone(NATIVE_DIALOG.search(js_code_only(editor_js())))
        wiki = (STATIC / "wiki.html").read_text(encoding="utf-8")
        self.assertLess(wiki.index("/static/js/ui.js?v="), wiki.index("/static/js/wiki-editor.js?v="))

    def test_delete_asks_in_page_and_checks_again_after(self):
        code = js_code_only(editor_js())
        remove = function_body(code, "remove")
        self.assertRegex(remove, r"var ok = await window\.WSUI\.confirm\(\{")
        self.assertIn("danger: true", remove)
        # The answer comes later: the delete only starts if this editor is
        # still the one showing and nothing else is writing from it.
        self.assertRegex(remove, r"if \(!ok \|\| _session !== s \|\| s\.busy\) return;\s*setBusy\(s, true\);")

    def test_a_page_that_will_not_load_is_a_toast(self):
        opened = function_body(js_code_only(editor_js()), "open")
        self.assertRegex(opened, r"window\.WSUI\.toast\('\s*', '\s{3}'\);\s*return;")
        self.assertEqual(len(live_matches(
            editor_js(), r"window\.WSUI\.toast\('Couldn’t load that page for editing\. Try again\.', 'err'\);")), 1)

    def test_restoring_a_draft_asks_in_page(self):
        opened = function_body(js_code_only(editor_js()), "open")
        self.assertRegex(opened, r"useDraft = await window\.WSUI\.confirm\(\{")
        # While the question was up the reader may have gone elsewhere; the
        # editor is then not drawn over the new view.
        self.assertRegex(opened, r"var here = location\.href;")
        self.assertRegex(opened, r"if \(location\.href !== here\) return;")

    def test_every_label_names_its_field(self):
        code = js_code_only(editor_js())
        field = function_body(code, "field")
        self.assertRegex(field, r"label\.htmlFor = control\.id;")
        self.assertIn("contentLabel.htmlFor = 'wikiEditContent';".replace("'wikiEditContent'", "'               '"), code)
        # Every control handed to field() has an id for its label to name.
        for name in ("title", "slugIn", "summary", "cat", "sort"):
            self.assertRegex(code, r"\b" + name + r"\.id = '")


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class HelpCardsFollowTheWikiSwitch(unittest.TestCase):
    """A help card links into the Wiki, so a switched-off Wiki shows none:
    the link would only bounce a member home, and the hidden wiki's page
    titles would reach them."""

    def setUp(self):
        from app.models import WikiPage
        self.Session = helpers.make_sessionmaker()
        self.db = self.Session()
        self.db.add(WikiPage(title="How to get help", slug="get-help", content="x", content_html="<p>x</p>",
                             published=True, author_name="Admin"))
        self.db.commit()
        for key in ("wiki.hook_tickets", "wiki.hook_issues", "wiki.hook_playback"):
            helpers.put(self.db, key, "get-help")

    def tearDown(self):
        self.db.close()

    def hooks(self):
        from app.routers.branding import load_branding
        return load_branding(self.db, True)["wiki_hooks"]

    def test_on_shows_the_cards(self):
        want = {"slug": "get-help", "title": "How to get help"}
        self.assertEqual(self.hooks(), {"tickets": want, "issues": want, "playback": want})
        helpers.put(self.db, "sidebar.enabled_wiki", "true")
        self.assertEqual(self.hooks()["tickets"], want)

    def test_off_shows_none(self):
        for off in ("false", " False "):
            with self.subTest(value=off):
                helpers.put(self.db, "sidebar.enabled_wiki", off)
                self.assertEqual(self.hooks(), {"tickets": None, "issues": None, "playback": None})

    def test_off_leaves_no_title_in_the_branding_payload(self):
        from unittest import mock as _mock
        helpers.put(self.db, "sidebar.enabled_wiki", "false")
        with _mock.patch("app.routers.setup.is_setup_completed", return_value=True):
            client = helpers.api_client(self.Session, helpers.MEMBER)
            try:
                r = client.get("/api/branding")
            finally:
                helpers.reset_overrides()
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("How to get help", r.text)


if __name__ == "__main__":
    unittest.main()
