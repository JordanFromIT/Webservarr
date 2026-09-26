"""
Tickets switched off while a member is writing: the draft stays, sending stops.

Once the ticket API answers a member with its "turned off" 403 (from a poll or
from the send itself), tickets.html shows a calm notice by the form's send
button and keeps the typed text. The notice says the message can't be sent, so
the button must agree: it is disabled, the send handlers refuse to post, a
send's own "turned off" 403 goes through the same notice instead of an error
toast, and the busy-state reset in .finally() cannot re-enable it. Any other
failure (400, 413, 500, the comment route's own "only the creator" 403) keeps
its toast.

There is no JavaScript runtime in the container, so these pin the control flow
statically, with the scanner from test_shell_contract. Each check is a function
of the page source, so the Mutations class can feed it a broken copy and prove
the check notices.
"""
import re
import unittest
from pathlib import Path

from app.tests.test_shell_contract import STATIC, js_code_only, matching_brace

TICKETS_ROUTER = Path(__file__).resolve().parents[1] / "routers" / "tickets.py"


def page() -> str:
    return (STATIC / "tickets.html").read_text(encoding="utf-8")


def code_of(html: str) -> str:
    """The page's inline scripts, comments removed and string contents blanked."""
    return js_code_only("\n".join(re.findall(r"<script>(.*?)</script>", html, re.S)))


def body(test, code: str, pattern: str, what: str) -> str:
    """Body of the function whose header (ending in its opening {) matches."""
    m = re.search(pattern, code)
    test.assertIsNotNone(m, f"{what} is missing")
    return code[m.end():matching_brace(code, m.end() - 1)]


def submit_body(test, code):
    return body(test, code, r"window\.submitNewTicket\s*=\s*function\s*\(\s*\)\s*\{", "submitNewTicket")


def comment_body(test, code):
    return body(test, code, r"sendBtn\.addEventListener\(\s*'\s*'\s*,\s*function\s*\(\s*\)\s*\{",
                "the comment send listener")


GUARD = r"^\s*if\s*\(\s*_ticketsOff\s*\)\s*return\s*;"


def catch_skips_toast(btn_body: str) -> bool:
    return re.search(r"\.catch\(\s*function\s*\(\s*(\w+)\s*\)\s*\{\s*if\s*\(\s*\1\s*!==\s*TICKETS_OFF\s*\)\s*showToast\(",
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
    m = re.search(r"var\s+TICKETS_OFF_DETAIL\s*=\s*'([^']*)'\s*;", html)
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
    m = re.search(r'<button[^>]*id="createSubmitBtn"[^>]*>', html)
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
    ("submit has no guard", "  window.submitNewTicket = function() {\n    if (_ticketsOff) return;\n",
     "  window.submitNewTicket = function() {\n", check_send_handlers_refuse_while_off),
    ("comment has no guard", "      sendBtn.addEventListener('click', function() {\n        if (_ticketsOff) return;\n",
     "      sendBtn.addEventListener('click', function() {\n", check_send_handlers_refuse_while_off),
    ("403 on status alone", " && d.detail === TICKETS_OFF_DETAIL", "", check_post_routes_only_the_off_403),
    ("admins take the off-flow", "if (!_isAdmin && r.status === 403", "if (r.status === 403",
     check_post_routes_only_the_off_403),
    ("detail drifts from the API", "var TICKETS_OFF_DETAIL = 'The ticket system is turned off';",
     "var TICKETS_OFF_DETAIL = 'Ticket system is disabled';", check_off_detail_matches_the_api),
    ("submit reset re-enables", "btn.disabled = _ticketsOff; btn.textContent = 'Submit Ticket';",
     "btn.disabled = false; btn.textContent = 'Submit Ticket';", check_toast_and_reset_respect_the_off_flow),
    ("comment toasts the off-flow", ".catch(function(e) { if (e !== TICKETS_OFF) showToast(e.message, 'error'); })\n"
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
    ui.js, loaded before the page script), never the browser's confirm()."""

    def test_the_page(self):
        from app.tests.test_settings_static import NATIVE_DIALOG
        html = page()
        code = code_of(html)
        self.assertIsNone(NATIVE_DIALOG.search(code))
        self.assertIn('<script src="/static/js/ui.js?v=', html)
        self.assertLess(html.index('/static/js/ui.js?v='), html.index("<script>\n"))
        self.assertRegex(code, r"window\.WSUI\.confirm\(\{[^}]*danger: true[^}]*\}\)\.then\(function \(ok\) \{\s*if \(!ok\) return;")


if __name__ == "__main__":
    unittest.main()
