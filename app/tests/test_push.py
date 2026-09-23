"""
Web Push signing, end to end.

seed.py stores the VAPID private key as a PKCS8 PEM block. pywebpush 2.x reads
a *string* key as bare base64 DER, so handing it the PEM text failed ASN.1
parsing inside webpush() and every push was dropped with a logged warning.
These tests take a key produced by the real seeding code, run it through the
real webpush() with only the HTTP POST mocked, and check that the request a
push service would receive carries a valid VAPID signature from the stored key
pair, with the audience of that device's own push service.
"""
import asyncio
import base64
import json
import os
import re
import unittest
from unittest import mock

try:
    import requests
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from app.database import Base
    from app.models import PushSubscription, Setting
    from app.seed import seed_vapid_keys
    from app.services import push
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64url_decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _browser_keys():
    """A p256dh/auth pair like a browser's PushSubscription.toJSON() gives."""
    key = ec.generate_private_key(ec.SECP256R1())
    point = key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return _b64url(point), _b64url(os.urandom(16))


class _Response:
    status_code = 201
    reason = "Created"
    text = ""
    headers = {}


def make_session_factory():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class SeededKeySignsPushes(unittest.TestCase):
    def setUp(self):
        self.Session = make_session_factory()
        db = self.Session()
        try:
            seed_vapid_keys(db)  # the real key generation and storage path
            self.public_key = (
                db.query(Setting).filter(Setting.key == "notifications.vapid_public_key").one().value
            )
            private = (
                db.query(Setting).filter(Setting.key == "notifications.vapid_private_key").one().value
            )
            self.assertTrue(private.startswith("-----BEGIN PRIVATE KEY-----"))
        finally:
            db.close()

    def _subscribe(self, email, endpoint):
        p256dh, auth = _browser_keys()
        db = self.Session()
        try:
            db.add(PushSubscription(user_email=email, endpoint=endpoint, p256dh=p256dh, auth=auth))
            db.commit()
        finally:
            db.close()

    def _dispatch(self, emails):
        posts = []

        def fake_post(session, url, **kwargs):
            posts.append((url, kwargs))
            return _Response()

        with mock.patch.object(push, "SessionLocal", self.Session), \
             mock.patch.object(push, "is_safe_push_endpoint", return_value=True), \
             mock.patch.object(requests.Session, "post", fake_post):
            result = asyncio.run(push.dispatch_push(emails, "Title", "Body", "news", "/"))
        return result, posts

    def _verify_vapid(self, headers, expected_aud):
        """Check the Authorization header like a push service would."""
        auth = headers["Authorization"]
        self.assertTrue(auth.startswith("vapid "), auth)
        parts = dict(p.split("=", 1) for p in auth[len("vapid "):].split(","))
        # k= is the key the browser subscribed with: it must be the stored one.
        self.assertEqual(parts["k"].strip(), self.public_key)

        token = parts["t"].strip()
        header_b64, claims_b64, sig_b64 = token.split(".")
        claims = json.loads(_b64url_decode(claims_b64))
        self.assertEqual(claims["aud"], expected_aud)

        sig = _b64url_decode(sig_b64)
        der = encode_dss_signature(int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big"))
        pub = ec.EllipticCurvePublicKey.from_encoded_point(
            ec.SECP256R1(), _b64url_decode(self.public_key)
        )
        try:
            pub.verify(der, f"{header_b64}.{claims_b64}".encode(), ec.ECDSA(hashes.SHA256()))
        except InvalidSignature:  # pragma: no cover - the assertion is the point
            self.fail("VAPID JWT is not signed by the stored key pair")

    def test_stored_pem_key_loads(self):
        db = self.Session()
        try:
            pem = db.query(Setting).filter(Setting.key == "notifications.vapid_private_key").one().value
        finally:
            db.close()
        vapid = push.load_vapid_key(pem)
        point = vapid.public_key.public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
        self.assertEqual(_b64url(point), self.public_key)

    def test_seeded_key_sends_a_signed_push(self):
        endpoint = "https://push.example.com/send/abc"
        self._subscribe("someone@example.com", endpoint)

        result, posts = self._dispatch(["Someone@Example.com"])

        self.assertEqual(result, {"attempted": 1, "succeeded": 1})
        self.assertEqual(len(posts), 1)
        url, kwargs = posts[0]
        self.assertEqual(url, endpoint)
        self._verify_vapid(kwargs["headers"], "https://push.example.com")
        # The body was encrypted for the browser, not sent as plain JSON.
        self.assertNotIn(b"Title", kwargs["data"])

    def test_each_device_is_signed_for_its_own_push_service(self):
        self._subscribe("someone@example.com", "https://push-a.example.com/send/1")
        self._subscribe("someone@example.com", "https://push-b.example.net/send/2")

        result, posts = self._dispatch(["someone@example.com"])

        self.assertEqual(result, {"attempted": 2, "succeeded": 2})
        by_url = {url: kwargs for url, kwargs in posts}
        self._verify_vapid(by_url["https://push-a.example.com/send/1"]["headers"],
                           "https://push-a.example.com")
        self._verify_vapid(by_url["https://push-b.example.net/send/2"]["headers"],
                           "https://push-b.example.net")

    def test_unreadable_key_sends_nothing(self):
        db = self.Session()
        try:
            row = db.query(Setting).filter(Setting.key == "notifications.vapid_private_key").one()
            row.value = "not a key"
            db.commit()
        finally:
            db.close()
        self._subscribe("someone@example.com", "https://push.example.com/send/abc")

        with self.assertLogs(push.logger, level="ERROR"):
            result, posts = self._dispatch(["someone@example.com"])

        self.assertEqual(result, {"attempted": 0, "succeeded": 0})
        self.assertEqual(posts, [])

    def test_push_icon_stays_same_origin(self):
        self.assertEqual(push._push_icon("/uploads/logo.png"), "/uploads/logo.png")
        self.assertEqual(push._push_icon("https://cdn.example.com/x.png"), push.DEFAULT_PUSH_ICON)
        self.assertEqual(push._push_icon("//evil.example.com/x.png"), push.DEFAULT_PUSH_ICON)
        self.assertEqual(push._push_icon(""), push.DEFAULT_PUSH_ICON)
        self.assertEqual(push._push_icon("/\\evil.example/x.png"), push.DEFAULT_PUSH_ICON)
        self.assertEqual(push._push_icon("/\t/evil.example/x.png"), push.DEFAULT_PUSH_ICON)


class DefaultIconTests(unittest.TestCase):
    """The fallback notification icon exists, is a PNG, and both sides agree."""

    STATIC = os.path.join(os.path.dirname(__file__), "..", "static")

    def test_service_worker_and_server_use_the_same_default(self):
        with open(os.path.join(self.STATIC, "sw.js"), encoding="utf-8") as f:
            sw = f.read()
        m = re.search(r"var DEFAULT_ICON = '([^']+)'", sw)
        self.assertIsNotNone(m)
        if HAVE_APP:
            self.assertEqual(m.group(1), push.DEFAULT_PUSH_ICON)
        self.assertTrue(m.group(1).endswith(".png"))

    def test_default_icon_is_a_real_png(self):
        with open(os.path.join(self.STATIC, "webservarr-192.png"), "rb") as f:
            self.assertEqual(f.read(8), b"\x89PNG\r\n\x1a\n")


if __name__ == "__main__":
    unittest.main()
