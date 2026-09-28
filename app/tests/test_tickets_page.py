"""
Tickets switched off while a member is writing: the draft stays, sending stops.

Once the ticket API answers a member with its "turned off" 403 (from a poll or
from the send itself), the Tickets page shows a calm notice by the form's send
button and keeps the typed text. The notice says the message can't be sent, so
the button must agree: it is disabled, the send handlers refuse to post, a
send's own "turned off" 403 goes through the same notice instead of an error
toast, and the busy-state reset in .finally() cannot re-enable it. Any other
failure (400, 413, 500, the comment route's own "only the creator" 403) keeps
its toast.

There is no JavaScript runtime in the container, so these pin the control flow
statically, with the scanner from test_shell_contract. Each check is a function
of the page's source (its module, js/pages/tickets.js, since the page became a
soft-navigation page; the markup is still read from tickets.html), so the
Mutations class can feed it a broken copy and prove the check notices.
"""
import re
import unittest
from pathlib import Path

from app.tests.test_shell_contract import STATIC, assert_ui_js_before, js_code_only, matching_brace

TICKETS_ROUTER = Path(__file__).resolve().parents[1] / "routers" / "tickets.py"


def markup() -> str:
    return (STATIC / "tickets.html").read_text(encoding="utf-8")


def page() -> str:
    """The page's script: its module (it has no inline script any more)."""
    return (STATIC / "js" / "pages" / "tickets.js").read_text(encoding="utf-8")


def code_of(src: str) -> str:
    """The page's script, comments removed and string contents blanked."""
    return js_code_only(src)


def body(test, code: str, pattern: str, what: str) -> str:
    """Body of the function whose header (ending in its opening {) matches."""
    m = re.search(pattern, code)
    test.assertIsNotNone(m, f"{what} is missing")
    return code[m.end():matching_brace(code, m.end() - 1)]


def submit_body(test, code):
    return body(test, code, r"\bfunction submitNewTicket\s*\(\s*\)\s*\{", "submitNewTicket")


def comment_body(test, code):
    return body(test, code, r"sendBtn\.addEventListener\(\s*'\s*'\s*,\s*function\s*\(\s*\)\s*\{",
                "the comment send listener")


GUARD = r"^\s*if\s*\(\s*_ticketsOff\s*\)\s*return\s*;"


def catch_skips_toast(btn_body: str) -> bool:
    # No toast for the off-flow, nor for a send cut short by leaving the page.
    return re.search(r"\.catch\(\s*function\s*\(\s*(\w+)\s*\)\s*\{\s*if\s*\(\s*\1\s*!==\s*TICKETS_OFF\s*"
                     r"&&\s*!isAbort\(\s*\1\s*\)\s*\)\s*showToast\(",
                     btn_body) is not None


def finally_keeps_off(btn_body: str, btn: str) -> bool:
    return (re.search(rf"\.finally\(\s*function\s*\(\s*\)\s*\{{\s*{btn}\.disabled\s*=\s*_ticketsOff\s*;", btn_body)
            is not None and re.search(r"\.disabled\s*=\s*false", btn_body) is None)


# ---- checks (each a function of the page source) ----

def check_notice_disables_send(test, html):
    code = code_of(html)
    b = body(test, code, r"\bfunction showOffNotice\s*\(\s*sendBtn\s*\)\s*\{", "showOffNotice(sendBtn)")
    test.assertRegex(b, r"^\s*sendBtn\.disabled\s*=\s*true\s*;",
                     "showOffNotice must disable the send button first, even when the notice is already there")


def check_send_handlers_refuse_while_off(test, html):
    code = code_of(html)
    test.assertRegex(submit_body(test, code), GUARD, "submitNewTicket must return at once while Tickets is off")
    test.assertRegex(comment_body(test, code), GUARD, "the comment send must return at once while Tickets is off")


def check_sends_use_the_off_aware_post(test, html):
    code = code_of(html)
    s, c = submit_body(test, code), comment_body(test, code)
    test.assertRegex(s, r"postTicketForm\(\s*'\s*'\s*,\s*formData\s*,\s*btn\s*\)", "the new-ticket POST")
    test.assertRegex(c, r"postTicketForm\(\s*'\s*'\s*\+\s*ticket\.id\s*\+\s*'\s*'\s*,\s*formData\s*,\s*sendBtn\s*\)",
                     "the comment POST")
    for name, b in (("submitNewTicket", s), ("comment send", c)):
        test.assertNotRegex(b, r"\bfetch\(", f"{name} must post through postTicketForm, not a bare fetch")


def check_post_routes_only_the_off_403(test, html):
    code = code_of(html)
    b = body(test, code, r"\bfunction postTicketForm\s*\(\s*url\s*,\s*formData\s*,\s*sendBtn\s*\)\s*\{", "postTicketForm")
    test.assertRegex(
        b,
        r"if\s*\(\s*!_isAdmin\s*&&\s*r\.status\s*===\s*403\s*&&\s*d\.detail\s*===\s*TICKETS_OFF_DETAIL\s*\)\s*\{"
        r"\s*ticketsTurnedOff\(\s*sendBtn\s*\)\s*;\s*throw\s+TICKETS_OFF\s*;\s*\}",
        "only a member's 403 carrying the turned-off detail may take the off-flow")
    test.assertRegex(b, r"throw\s+new\s+Error\(\s*d\.detail\s*\|\|", "every other failure still rejects with its detail")
    t = body(test, code, r"\bfunction ticketsTurnedOff\s*\(\s*sendBtn\s*\)\s*\{", "ticketsTurnedOff(sendBtn)")
    test.assertRegex(t, r"sendBtn\s*=\s*sendBtn\s*\|\|\s*draftSendButton\(\s*\)\s*;",
                     "a send's own 403 puts the notice by that send's button")


def check_off_detail_matches_the_api(test, html):
    m = re.search(r"(?:var|const)\s+TICKETS_OFF_DETAIL\s*=\s*'([^']*)'\s*;", html)
    test.assertIsNotNone(m, "TICKETS_OFF_DETAIL is missing")
    router = TICKETS_ROUTER.read_text(encoding="utf-8")
    test.assertIn(f'detail="{m.group(1)}"', router,
                  "the page's turned-off detail must be the exact text tickets.py sends")


def check_toast_and_reset_respect_the_off_flow(test, html):
    code = code_of(html)
    s, c = submit_body(test, code), comment_body(test, code)
    test.assertTrue(catch_skips_toast(s), "submitNewTicket shows no toast for the off-flow")
    test.assertTrue(catch_skips_toast(c), "the comment send shows no toast for the off-flow")
    test.assertTrue(finally_keeps_off(s, "btn"), "submitNewTicket's reset must not re-enable an off button")
    test.assertTrue(finally_keeps_off(c, "sendBtn"), "the comment send's reset must not re-enable an off button")


def check_send_buttons_look_disabled(test, html):
    m = re.search(r'<button[^>]*id="createSubmitBtn"[^>]*>', markup())
    test.assertIsNotNone(m, "#createSubmitBtn is missing")
    test.assertIn("disabled:opacity-30", m.group(0))
    test.assertIn("disabled:cursor-not-allowed", m.group(0))
    m = re.search(r"var sendBtn = createEl\('button', '([^']*)'", html)
    test.assertIsNotNone(m, "the comment send button is missing")
    test.assertIn("disabled:opacity-30", m.group(1))
    test.assertIn("disabled:cursor-not-allowed", m.group(1))


CHECKS = [check_notice_disables_send, check_send_handlers_refuse_while_off, check_sends_use_the_off_aware_post,
          check_post_routes_only_the_off_403, check_off_detail_matches_the_api,
          check_toast_and_reset_respect_the_off_flow, check_send_buttons_look_disabled]


class TicketsOffWhileWriting(unittest.TestCase):
    def test_the_page(self):
        html = page()
        for check in CHECKS:
            with self.subTest(check.__name__):
                check(self, html)


MUTATIONS = [
    ("notice leaves send live", "    sendBtn.disabled = true;\n    var prev", "    var prev",
     check_notice_disables_send),
    ("submit has no guard", "  function submitNewTicket() {\n    if (_ticketsOff) return;\n",
     "  function submitNewTicket() {\n", check_send_handlers_refuse_while_off),
    ("comment has no guard", "      sendBtn.addEventListener('click', function() {\n        if (_ticketsOff) return;\n",
     "      sendBtn.addEventListener('click', function() {\n", check_send_handlers_refuse_while_off),
    ("403 on status alone", " && d.detail === TICKETS_OFF_DETAIL", "", check_post_routes_only_the_off_403),
    ("admins take the off-flow", "if (!_isAdmin && r.status === 403", "if (r.status === 403",
     check_post_routes_only_the_off_403),
    ("detail drifts from the API", "const TICKETS_OFF_DETAIL = 'The ticket system is turned off';",
     "const TICKETS_OFF_DETAIL = 'Ticket system is disabled';", check_off_detail_matches_the_api),
    ("submit reset re-enables", "btn.disabled = _ticketsOff; btn.textContent = 'Submit Ticket';",
     "btn.disabled = false; btn.textContent = 'Submit Ticket';", check_toast_and_reset_respect_the_off_flow),
    ("comment toasts the off-flow", ".catch(function(e) { if (e !== TICKETS_OFF && !isAbort(e)) showToast(e.message, 'error'); })\n"
     "          .finally(function() { sendBtn",
     ".catch(function(e) { showToast(e.message, 'error'); })\n          .finally(function() { sendBtn",
     check_toast_and_reset_respect_the_off_flow),
    ("comment posts with bare fetch",
     "postTicketForm('/api/tickets/' + ticket.id + '/comments', formData, sendBtn)",
     "fetch('/api/tickets/' + ticket.id + '/comments', { method: 'POST', body: formData })",
     check_sends_use_the_off_aware_post),
]


class Mutations(unittest.TestCase):
    def test_each_check_notices_its_breakage(self):
        html = page()
        for name, original, broken, check in MUTATIONS:
            with self.subTest(name):
                self.assertEqual(html.count(original), 1, f"the text to break is not in the page exactly once: {name}")
                with self.assertRaises(AssertionError):
                    check(self, html.replace(original, broken))


class TicketDeleteDialog(unittest.TestCase):
    """Deleting a ticket asks with the site's own dialog (WSUI.confirm from
    ui.js, which the shell loads before the page module), never the browser's confirm()."""

    def test_the_page(self):
        from app.tests.test_settings_static import NATIVE_DIALOG
        code = code_of(page())
        self.assertIsNone(NATIVE_DIALOG.search(code))
        assert_ui_js_before(self, markup(), 'data-ws-module="/static/js/pages/tickets.js?v=')
        self.assertRegex(code, r"window\.WSUI\.confirm\(\{[^}]*danger: true[^}]*\}\)\.then\(function \(ok\) \{\s*if \(!ok\) return;")


def listener(src: str, head: str) -> str:
    """The body of one of the detail's click listeners, as written."""
    start = src.index(head)
    return src[start:src.index("}, { signal: signal });", start)]


class AdminDelete(unittest.TestCase):
    """The delete route answers 204 with no body. Parsing that as JSON threw,
    so the admin saw "Failed to delete" on a ticket that was gone and the
    modal stayed open. Success is r.ok with nothing parsed; a failure shows
    the server's own detail."""

    def test_a_204_is_success(self):
        d = listener(page(), "delBtn.addEventListener('click', function() {")
        self.assertRegex(d, r"fetch\('/api/admin/tickets/' \+ ticket\.id, \{ method: 'DELETE', signal: signal \}\)\s*"
                            r"\.then\(function \(r\) \{\s*if \(r\.ok\) return;")
        ok = d[d.index("if (r.ok) return;"):]
        ok = ok[ok.index("})\n            .then(function() {"):ok.index(".catch(function(err)")]
        for step in ("closeDetailModal();", "showToast('Ticket deleted', 'success');", "loadTickets();", "loadCounts();"):
            self.assertIn(step, ok)

    def test_a_failure_shows_the_servers_detail(self):
        d = listener(page(), "delBtn.addEventListener('click', function() {")
        self.assertIn("return r.json().catch(function () { return {}; }).then(function (b) {", d)
        self.assertIn("var e = new Error(b.detail || 'Failed to delete'); e.server = true; throw e;", d)
        self.assertIn(".catch(function(err) { if (!isAbort(err)) showToast(err.server ? err.message : 'Failed to delete', 'error'); });", d)


if __name__ == "__main__":
    unittest.main()
