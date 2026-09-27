"""
R181: the Home push card answers the tap, leaves the moment the browser grants
permission, and comes back if the subscribe or the save then fails.

It used to stay until subscribePush() settled (a push-service round trip and a
POST, seconds on a slow link) and then only swapped its buttons for a line of
text, so after "Allow" the card looked like nothing had happened.
"""
import re
import unittest

from app.tests.test_shell_contract import STATIC, live_matches, matching_brace, read

SRC = (STATIC / "js" / "notifications.js").read_text(encoding="utf-8")


def body_of(src: str, fn: str) -> str:
    m = re.search(rf"\bfunction {fn}\([^)]*\)\s*\{{", src)
    assert m, fn
    return src[m.end():matching_brace(src, m.end() - 1)]


def enable_handler() -> str:
    init = body_of(SRC, "initPushPrompt")
    m = live_matches(init, r"enableBtn\.addEventListener\(\s*'click'\s*,\s*function\s*\(\s*\)\s*\{")
    assert len(m) == 1, "one click handler on Turn on"
    return init[m[0].end():matching_brace(init, m[0].end() - 1)]


class PushPromptLeavesOnGrant(unittest.TestCase):
    def test_subscribe_reports_the_grant_before_subscribing(self):
        self.assertRegex(SRC, r"\bfunction subscribePush\(\s*onGranted\s*\)")
        body = body_of(SRC, "subscribePush")
        granted = live_matches(body, r"\bonGranted\(\s*\)")
        self.assertEqual(len(granted), 1, "onGranted() is called once")
        at = granted[0].start()
        # After the permission check, before the worker wait and the subscribe.
        self.assertLess(live_matches(body, r"permission\s*!==\s*'granted'")[0].start(), at)
        self.assertGreater(live_matches(body, r"\bswReady\(\s*\)")[0].start(), at)
        self.assertGreater(live_matches(body, r"\bcurrentSubscription\(")[0].start(), at)
        self.assertGreater(live_matches(body, r"\bpostSubscription\(")[0].start(), at)

    def test_the_card_hides_on_the_grant(self):
        handler = enable_handler()
        m = live_matches(handler, r"\bsubscribePush\(\s*function\s*\(\s*\)\s*\{")
        self.assertEqual(len(m), 1, "the prompt passes an onGranted callback")
        cb = handler[m[0].end():matching_brace(handler, m[0].end() - 1)]
        self.assertTrue(live_matches(cb, r"\bhidePushPrompt\(\s*card\s*\)"), "hidden in onGranted")
        # No success path left that waits on the subscribe to change the card.
        self.assertTrue(live_matches(handler, r"\}\)\.then\(\s*null\s*,\s*function\s*\(\s*err\s*\)"))
        self.assertNotIn("You're all set", SRC)

    def test_the_tap_is_answered_at_once(self):
        handler = enable_handler()
        busy = live_matches(handler, r"\bsetPromptBusy\(\s*enableBtn\s*,\s*true\s*\)")
        self.assertTrue(busy)
        self.assertLess(busy[0].start(), live_matches(handler, r"\bsubscribePush\(")[0].start())
        setter = body_of(SRC, "setPromptBusy")
        self.assertTrue(live_matches(setter, r"\bbtn\.disabled\s*=\s*busy\b"))
        # Both labels are always laid out, so the button never changes width.
        page = read("index")
        button = re.search(r"<button[^>]*data-push-prompt-enable[^>]*>(.*?)</button>", page, re.S).group(1)
        self.assertIn('<span class="inline-grid">', button)
        self.assertRegex(button, r'<span data-push-label-idle class="col-start-1 row-start-1">Turn on</span>')
        self.assertRegex(button, r'<span data-push-label-busy class="col-start-1 row-start-1 invisible">Turning on…</span>')

    def test_a_failure_after_the_grant_toasts_and_brings_the_card_back(self):
        handler = enable_handler()
        m = live_matches(handler, r"if\s*\(\s*gone\s*\)\s*\{")
        self.assertTrue(m, "the after-grant failure branch")
        branch = handler[m[-1].end():matching_brace(handler, m[-1].end() - 1)]
        self.assertTrue(live_matches(branch, r"\bpromptFailure\(\s*msg\s*,\s*PUSH_MESSAGES\[kind\]\s*\)"))
        self.assertTrue(live_matches(branch, r"\bshowPushPrompt\(\s*card\s*\)"))
        # Re-enabled before it returns, so it can be retried.
        before = handler[:m[-1].start()]
        self.assertTrue(live_matches(before, r"\bsetPromptBusy\(\s*enableBtn\s*,\s*false\s*\)"))
        self.assertTrue(live_matches(before, r"\blaterBtn\.disabled\s*=\s*false\b"))
        self.assertTrue(live_matches(body_of(SRC, "promptFailure"), r"\bWSUI\.toast\(\s*text\s*,\s*'err'\s*\)"))
        # The toast lives in ui.js, which Home now loads.
        self.assertIn('<script src="/static/js/ui.js?v=1"></script>', read("index"))

    def test_refusals_keep_their_rules(self):
        handler = enable_handler()
        self.assertTrue(live_matches(handler, r"if\s*\(\s*kind\s*===\s*'blocked'\s*\)\s*\{\s*hidePushPrompt\(\s*card\s*\)\s*;\s*return;"))
        dismiss = live_matches(handler, r"kind\s*===\s*'dismissed'\s*\|\|\s*kind\s*===\s*'noEmail'\s*\|\|\s*kind\s*===\s*'unconfigured'")
        self.assertEqual(len(dismiss), 1)

    def test_a_return_cancels_a_collapse_still_running(self):
        # The collapse finishes on a timer; a return must stop it, or the card
        # would come back and then vanish when the old timer fired.
        hide, show = body_of(SRC, "hidePushPrompt"), body_of(SRC, "showPushPrompt")
        self.assertTrue(live_matches(hide, r"card\._pushPromptTimer\s*=\s*setTimeout\("))
        self.assertTrue(live_matches(show, r"clearTimeout\(\s*card\._pushPromptTimer\s*\)"))
        self.assertTrue(live_matches(show, r"card\.hidden\s*=\s*false"))
        for body in (hide, show):
            self.assertIn("prefers-reduced-motion: reduce", body)


if __name__ == "__main__":
    unittest.main()
