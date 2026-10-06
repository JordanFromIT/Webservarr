"""
R181: the Home push card answers the tap, leaves the moment the browser grants
permission, and comes back if the subscribe or the save then fails.

It used to stay until subscribePush() settled (a push-service round trip and a
POST, seconds on a slow link) and then only swapped its buttons for a line of
text, so after "Allow" the card looked like nothing had happened.
"""
import re
import unittest

from app.tests.test_shell_contract import STATIC, assert_ui_js_before, live_matches, matching_brace, read

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
        # The busy one is a spinner, its words for screen readers, so the
        # button is only as wide as "Turn on" (the banner's words keep the room).
        self.assertIn('<span data-push-label-busy class="col-start-1 row-start-1 invisible flex items-center justify-center">'
                      '<span class="material-symbols-outlined text-xl leading-5 motion-safe:animate-spin" aria-hidden="true">'
                      'progress_activity</span><span class="sr-only">Turning on…</span></span>', button)

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
        # The toast lives in ui.js, which the shell loads on Home as on every shell page.
        assert_ui_js_before(self, read("index"), "/static/js/notifications.js?v=")

    def test_subscribe_and_save_are_time_bounded(self):
        # R184: the card has gone by the time these run, so a hang must end in
        # a rejection the failure path can show.
        self.assertRegex(SRC, r"var SUBSCRIBE_TIMEOUT_MS = 15000;")
        self.assertRegex(SRC, r"var SAVE_TIMEOUT_MS = 10000;")
        cur = body_of(SRC, "currentSubscription")
        self.assertTrue(live_matches(cur, r"\bwithTimeout\(\s*reg\.pushManager\.subscribe\("))
        self.assertTrue(live_matches(cur, r"\}\),\s*SUBSCRIBE_TIMEOUT_MS\s*,\s*'subscribe-timeout'\)"))
        send = body_of(SRC, "sendSubscription")
        self.assertTrue(live_matches(send, r"\bwithTimeout\(\s*fetch\(\s*'/api/notifications/push-subscribe'"))
        self.assertTrue(live_matches(send, r"\}\),\s*SAVE_TIMEOUT_MS\s*,\s*'save-timeout'\s*,"))
        # A timeout rejects with a plain Error, which pushFailureKind reads as
        # 'failed': the generic branch, so toast, card back, button enabled.
        helper = body_of(SRC, "withTimeout")
        self.assertTrue(live_matches(helper, r"setTimeout\(\s*function\s*\(\s*\)\s*\{\s*reject\(\s*new Error\(\s*reason\s*\)\s*\)"))
        self.assertTrue(live_matches(helper, r"clearTimeout\(\s*timer\s*\)"))
        kinds = body_of(SRC, "pushFailureKind")
        self.assertNotIn("subscribe-timeout", kinds)
        self.assertNotIn("save-timeout", kinds)

    def test_a_timed_out_save_is_rechecked_before_it_counts_as_failed(self):
        # R186: a save that timed out may have landed (a slow write). One
        # bounded status check decides: saved -> success, nothing undone;
        # not saved, or the check fails or times out -> the failure path.
        self.assertRegex(SRC, r"var SAVE_RECHECK_TIMEOUT_MS = 5000;")
        body = body_of(SRC, "subscribePush")
        self.assertTrue(live_matches(
            body, r"return postSubscription\(result\.subscription\)\.catch\(function\s*\(\s*err\s*\)\s*\{\s*"
                  r"return savedAfterAll\(result\.subscription,\s*err\);\s*\}\);"))
        # The recheck sits before the success/failure split, so a "saved"
        # answer reaches markPushSynced/setPushOff(false) and skips the undo.
        at = live_matches(body, r"\bsavedAfterAll\(")[0].start()
        self.assertLess(at, live_matches(body, r"\bmarkPushSynced\(\s*\)")[0].start())
        self.assertLess(at, live_matches(body, r"\bcreated\.unsubscribe\(\s*\)")[0].start())
        check = body_of(SRC, "savedAfterAll")
        # Only the save timeout is rechecked; anything else is rethrown as is.
        self.assertTrue(live_matches(
            check, r"if\s*\(\s*!err\s*\|\|\s*err\.message\s*!==\s*'save-timeout'\s*\)\s*return Promise\.reject\(\s*err\s*\);"))
        self.assertTrue(live_matches(
            check, r"withTimeout\(\s*serverHasSubscription\(\s*subscription\s*\)\s*,\s*SAVE_RECHECK_TIMEOUT_MS\s*,\s*'recheck-timeout'\s*\)"))
        # Saved -> resolves; not saved -> original error; check failed -> original error.
        self.assertTrue(live_matches(check, r"\.then\(function\s*\(\s*saved\s*\)\s*\{\s*if\s*\(\s*!saved\s*\)\s*throw err;\s*\}\s*,\s*function\s*\(\s*\)\s*\{\s*throw err;\s*\}\)"))

    def test_the_timed_out_save_is_aborted_at_the_deadline(self):
        send = body_of(SRC, "sendSubscription")
        self.assertTrue(live_matches(send, r"\bnew AbortController\(\s*\)"))
        self.assertTrue(live_matches(send, r"\bsignal:\s*controller\s*\?\s*controller\.signal\s*:\s*undefined"))
        self.assertTrue(live_matches(
            send, r"SAVE_TIMEOUT_MS\s*,\s*'save-timeout'\s*,\s*function\s*\(\s*\)\s*\{\s*if\s*\(\s*controller\s*\)\s*controller\.abort\(\s*\);\s*\}"))
        helper = body_of(SRC, "withTimeout")
        self.assertRegex(SRC, r"function withTimeout\(promise, ms, reason, onTimeout\)")
        # At the deadline: reject first (so the abort's own rejection is
        # dropped), then cancel.
        self.assertTrue(live_matches(
            helper, r"reject\(new Error\(reason\)\);\s*if\s*\(\s*onTimeout\s*\)\s*onTimeout\(\s*\);"))
        # The subscribe keeps its plain bound (no abort to give it).
        cur = body_of(SRC, "currentSubscription")
        self.assertTrue(live_matches(cur, r"\}\),\s*SUBSCRIBE_TIMEOUT_MS\s*,\s*'subscribe-timeout'\)"))

    def test_a_refusal_after_the_grant_without_a_toast_shows_the_card(self):
        # R185: with no ui.js the message goes in the card, so the card must
        # come back to show it, with its buttons usable.
        self.assertTrue(live_matches(body_of(SRC, "promptFailure"), r"return false;"))
        handler = enable_handler()
        m = live_matches(handler, r"if\s*\(\s*gone\s*&&\s*!promptFailure\(\s*msg\s*,\s*PUSH_MESSAGES\[kind\]\s*\)\s*\)\s*\{")
        self.assertEqual(len(m), 1)
        branch = handler[m[0].end():matching_brace(handler, m[0].end() - 1)]
        for pattern in (r"\bsetPromptBusy\(\s*enableBtn\s*,\s*false\s*\)", r"\blaterBtn\.disabled\s*=\s*false\b",
                        r"\bshowPushPrompt\(\s*card\s*\)"):
            self.assertTrue(live_matches(branch, pattern), pattern)

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
