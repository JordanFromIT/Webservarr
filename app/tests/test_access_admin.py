"""
Settings > Access requests on the server (spec section 6, admin): the list, the count, the
libraries, approve (one share, approval final even when the share fails), deny, block and unblock.
Through the whole app and the real session lookup, so signed-out callers get 401 and members 403.
The routes work with the feature switched off. Plex is faked at the share client.
"""
import asyncio  # noqa: F401
import json
import unittest
from datetime import timedelta
from unittest import mock

try:
    import httpx  # noqa: F401
    from fastapi import FastAPI  # noqa: F401
    HAVE_APP = True
except ImportError:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False

if HAVE_APP:
    from app.auth import session_manager
    from app.integrations import plex_share
    from app.models import AccessRequest
    from app.services import access_requests as svc
    from app.tests import helpers
    from app.tests.test_access_public import FakeRedis
    from app.tests.test_settings_gate import ADMIN_SID, MEMBER_SID, SettingsGateBase, _admin_operations

ADMIN = {**helpers.ADMIN, "auth_method": "plex", "user_id": "7", "plex_account_id": "7"} if HAVE_APP else {}
LIBS = [{"key": "1", "title": "Movies", "type": "movie"}, {"key": "2", "title": "TV", "type": "show"}]
API = "/api/admin/access-requests"


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class AdminRoutes(SettingsGateBase):
    def setUp(self):
        super().setUp()
        sessions = {ADMIN_SID: dict(ADMIN), MEMBER_SID: dict(helpers.MEMBER)}

        async def get_session(session_id):
            return sessions.get(session_id)
        self.redis = FakeRedis()
        self.libraries = mock.AsyncMock(return_value=[dict(x) for x in LIBS])
        self.share = mock.AsyncMock(return_value=("shared", None))
        for p in (mock.patch.object(session_manager, "get_session", side_effect=get_session),
                  mock.patch.object(session_manager, "get_redis", mock.AsyncMock(return_value=self.redis)),
                  mock.patch.object(plex_share, "list_libraries", self.libraries),
                  mock.patch.object(plex_share, "share_server", self.share)):
            p.start()
            self.addCleanup(p.stop)
        self.now = svc.now_utc().replace(microsecond=0)
        self.admin = self.client(ADMIN_SID)

    def add(self, account_id, status, minutes_ago=0, **kw):
        at = self.now - timedelta(minutes=minutes_ago)
        row = AccessRequest(plex_account_id=account_id, plex_username="user" + account_id,
                            plex_email=f"u{account_id}@example.com", name="Name " + account_id,
                            note="Line one\n<b>not bold</b>", status=status, created_at=at, **kw)
        self.db.add(row)
        self.db.commit()
        return row.id

    def row(self, rid):
        self.db.expire_all()
        return self.db.get(AccessRequest, rid)

    # ---- who may call ----

    def test_signed_out_401_member_403(self):
        rid = self.add("1", "pending")
        routes = [("get", API), ("get", API + "/count"), ("get", API + "/libraries"),
                  ("post", f"{API}/{rid}/approve"), ("post", f"{API}/{rid}/deny"), ("post", f"{API}/{rid}/unblock")]
        for method, path in routes:
            with self.subTest(path=path):
                self.assertEqual(self.client().request(method, path, json={}).status_code, 401)
                r = self.client(MEMBER_SID).request(method, path, json={})
                self.assertEqual((r.status_code, r.json()["detail"]), (403, "Admin access required"))
        self.assertEqual(self.row(rid).status, "pending")
        self.share.assert_not_awaited()

    def test_the_settings_gate_sweep_covers_them(self):
        found = set(_admin_operations())
        for op in (("get", API), ("get", API + "/count"), ("get", API + "/libraries"),
                   ("post", API + "/{request_id}/approve"), ("post", API + "/{request_id}/deny"),
                   ("post", API + "/{request_id}/unblock")):
            self.assertIn(op, found)

    # ---- reading ----

    def test_the_list(self):
        old = self.add("1", "pending", minutes_ago=60)
        new = self.add("2", "pending", minutes_ago=5)
        approved = self.add("3", "approved", decided_at=self.now - timedelta(days=1), share_state="failed",
                            share_error="Plex refused the share (HTTP 400)", library_keys='["1"]')
        denied = self.add("4", "denied", decided_at=self.now - timedelta(hours=1),
                          cooldown_until=self.now + timedelta(days=29))
        self.add("5", "approved", decided_at=self.now - timedelta(days=31))
        blocked = self.add("6", "blocked", decided_at=self.now - timedelta(days=200))
        r = self.admin.get(API)
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual([x["id"] for x in body["pending"]], [old, new])
        self.assertEqual([x["id"] for x in body["decided"]], [denied, approved])
        self.assertEqual([x["id"] for x in body["blocked"]], [blocked])
        first = body["pending"][0]
        self.assertEqual(first["note"], "Line one\n<b>not bold</b>")
        self.assertEqual(set(first), {"id", "plex_username", "plex_email", "avatar_url", "name", "note", "status",
                                      "share_state", "share_error", "library_keys", "created_at", "decided_at",
                                      "can_ask_after"})
        failed = body["decided"][1]
        self.assertEqual((failed["share_state"], failed["share_error"], failed["library_keys"]),
                         ("failed", "Plex refused the share (HTTP 400)", ["1"]))
        self.assertNotIn('"plex_account_id"', r.text)

    def test_the_count(self):
        self.add("1", "pending")
        self.add("2", "pending")
        self.add("3", "blocked", decided_at=self.now)
        self.assertEqual(self.admin.get(API + "/count").json(), {"pending": 2})

    def test_the_libraries(self):
        self.assertEqual(self.admin.get(API + "/libraries").json(), {"libraries": LIBS})
        self.libraries.side_effect = plex_share.PlexShareUnavailable("Plex didn't answer")
        r = self.admin.get(API + "/libraries")
        self.assertEqual((r.status_code, r.json()["detail"]), (503, "Plex didn't answer"))

    def test_works_with_the_feature_off(self):
        helpers.put(self.db, "access_requests.enabled", "false")
        rid = self.add("1", "pending")
        self.assertEqual(self.admin.get(API + "/count").json(), {"pending": 1})
        self.assertEqual(self.admin.post(f"{API}/{rid}/deny", json={"block": False}).status_code, 200)

    # ---- approve ----

    def approve(self, rid, keys=("1",)):
        return self.admin.post(f"{API}/{rid}/approve", json={"library_keys": list(keys)})

    def test_approve_shares_once_and_records_it(self):
        rid = self.add("5551", "pending")
        r = self.approve(rid, ("2", "1"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["status"], r.json()["share_state"]), ("approved", "shared"))
        self.share.assert_awaited_once_with({"plex_account_id": "5551", "plex_username": "user5551"}, ["2", "1"])
        row = self.row(rid)
        self.assertEqual((row.status, row.decided_by, json.loads(row.library_keys), row.share_state),
                         ("approved", "plex:7", ["2", "1"], "shared"))
        self.assertEqual(self.approve(rid).status_code, 409)
        self.share.assert_awaited_once()
        self.assertNotIn(f"access_approve:{rid}", self.redis.data)

    def test_approval_is_saved_before_the_share_and_stays_when_it_fails(self):
        rid = self.add("5551", "pending")
        seen = []

        async def share(account, keys):
            seen.append(self.row(rid).status)
            return "failed", "Plex refused the share (HTTP 400)"
        self.share.side_effect = share
        r = self.approve(rid)
        self.assertEqual(seen, ["approved"])
        self.assertEqual((r.status_code, r.json()["status"], r.json()["share_state"], r.json()["share_error"]),
                         (200, "approved", "failed", "Plex refused the share (HTTP 400)"))

    def test_the_share_is_sent_by_account_id_only(self):
        for has_username in (True, False):
            with self.subTest(has_plex_username=has_username):
                self.share.reset_mock()
                rid = self.add(f"555{int(has_username)}", "pending", has_plex_username=has_username)
                self.assertEqual(self.approve(rid).status_code, 200)
                self.share.assert_awaited_once_with({"plex_account_id": f"555{int(has_username)}"}, ["1"])

    def test_an_invite_to_another_account_tells_the_admins(self):
        rid = self.add("5551", "pending")
        self.share.return_value = ("failed", plex_share.WRONG_ACCOUNT)
        told = mock.AsyncMock(return_value=1)
        with mock.patch.object(svc, "notify_wrong_account", told):
            r = self.approve(rid)
            self.assertEqual((r.status_code, r.json()["share_state"], r.json()["share_error"]),
                             (200, "failed", plex_share.WRONG_ACCOUNT))
            self.assertEqual(told.await_args.args[2].id, rid)
            told.reset_mock()
            self.share.return_value = ("failed", "Plex didn't confirm the share")
            self.approve(self.add("5552", "pending"))
            told.assert_not_awaited()      # only a stray invite rings the bell

    def test_approve_refusals(self):
        rid = self.add("1", "pending")
        for keys in ([], ["9"], ["abc"], ["1", "x"]):
            with self.subTest(keys=keys):
                self.assertEqual(self.approve(rid, keys).status_code, 422)
        self.assertEqual(self.admin.post(f"{API}/{rid}/approve", json={"library_keys": ["1"] * 51}).status_code, 422)
        self.assertEqual(self.approve(9999).status_code, 404)
        done = self.add("2", "denied", decided_at=self.now, cooldown_until=self.now + timedelta(days=30))
        self.assertEqual(self.approve(done).status_code, 409)
        self.share.assert_not_awaited()
        self.assertEqual(self.row(rid).status, "pending")

    def test_plex_down_leaves_the_request_pending(self):
        rid = self.add("1", "pending")
        self.libraries.side_effect = plex_share.PlexShareUnavailable("Plex didn't answer")
        r = self.approve(rid)
        self.assertEqual((r.status_code, r.json()["detail"]), (503, "Plex didn't answer"))
        self.assertEqual(self.row(rid).status, "pending")
        self.share.assert_not_awaited()

    def test_an_approve_in_flight_blocks_a_second(self):
        rid = self.add("1", "pending")
        self.redis.data[f"access_approve:{rid}"] = b"1"
        self.assertEqual(self.approve(rid).status_code, 409)
        self.assertEqual(self.row(rid).status, "pending")
        self.share.assert_not_awaited()

    def test_approve_needs_the_same_origin(self):
        rid = self.add("1", "pending")
        c = self.client(ADMIN_SID)
        c.headers.pop("Origin")
        r = c.post(f"{API}/{rid}/approve", json={"library_keys": ["1"]})
        self.assertEqual(r.status_code, 403)
        self.share.assert_not_awaited()

    # ---- deny, block, unblock ----

    def test_deny_starts_the_cooldown(self):
        rid = self.add("1", "pending")
        r = self.admin.post(f"{API}/{rid}/deny", json={"block": False})
        self.assertEqual(r.status_code, 200, r.text)
        row = self.row(rid)
        self.assertEqual((row.status, row.decided_by), ("denied", "plex:7"))
        self.assertLessEqual(abs((row.cooldown_until - row.decided_at) - svc.COOLDOWN), timedelta(seconds=1))
        self.assertEqual(self.admin.post(f"{API}/{rid}/deny", json={"block": True}).status_code, 409)

    def test_block_and_unblock(self):
        rid = self.add("1", "pending")
        self.assertEqual(self.admin.post(f"{API}/{rid}/deny", json={"block": True}).json()["status"], "blocked")
        self.assertIsNone(self.row(rid).cooldown_until)
        self.assertEqual(self.admin.post(f"{API}/{rid}/unblock").json(), {"ok": True})
        self.assertIsNone(self.row(rid))
        self.assertEqual(self.admin.post(f"{API}/{rid}/unblock").status_code, 404)
        pending = self.add("2", "pending")
        self.assertEqual(self.admin.post(f"{API}/{pending}/unblock").status_code, 409)

    def test_deny_takes_a_real_boolean(self):
        rid = self.add("1", "pending")
        self.assertEqual(self.admin.post(f"{API}/{rid}/deny", json={"block": "yes"}).status_code, 422)
        self.assertEqual(self.row(rid).status, "pending")


if __name__ == "__main__":
    unittest.main()
