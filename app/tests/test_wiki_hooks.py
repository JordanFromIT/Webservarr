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
        self.assertEqual(data["help_holders"]["tickets"], "A")
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
            src, r"line\.appendChild\(el\('span', '[^']*', '\(now on “' \+ holders\[h\[0\]\] \+ '” — ticking moves it here\)'\)\);")), 1)
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
        self.assertIn("_session = { slug: _slug, helpBase: helpBase, form: null, busy: false };", opened)

    def test_a_restored_draft_keeps_only_boxes_the_admin_changed(self):
        code = js_code_only(editor_js())
        opened = function_body(code, "open")
        self.assertRegex(opened, r"var touched = Array\.isArray\(f\.help_on\) && Array\.isArray\(f\.help_base\) &&\s*"
                                 r"helpKey\(f\.help_on\) !== helpKey\(f\.help_base\);")
        self.assertIn("initial = Object.assign({}, f, { help_on: touched ? f.help_on.slice() : helpBase.slice() });", opened)
        self.assertIn("fields.help_base = s.helpBase.slice();", function_body(code, "mirror"))

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


if __name__ == "__main__":
    unittest.main()
