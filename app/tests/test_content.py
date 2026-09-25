"""
app/content.py: the one sanitiser news and wiki content both go through.

A link or image address that a browser resolves to another site while it looks
like a local path must not survive: a protocol-relative "//host", or any
backslash (URL parsing treats "\\" as "/", so "/\\evil.com" is evil.com).
Tabs and newlines are dropped by the URL parser too, so they cannot hide a
"//". Local paths, http(s) and mailto: addresses keep working.
"""
import unittest

try:
    from app.content import render_markdown, sanitize_html
    HAVE_APP = True
except Exception:  # pragma: no cover
    HAVE_APP = False

BAD = [
    "/\\evil.com",
    "/\\/evil.com",
    "//evil.com",
    "\\\\evil.com",
    " //evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "https:\\\\evil.com",
    # Bleach keeps character references as written and the browser decodes
    # them, so the check reads the decoded value.
    "/&#92;evil.com",
    "/&#x5c;evil.com",
    "/&bsol;evil.com",
    "&sol;&sol;evil.com",
    "/&Tab;/evil.com",
    "javascript:alert(1)",     # already stripped by bleach; stays stripped
]
GOOD = [
    "/uploads/x.png",
    "/wiki/page",
    "/api/wiki/images/a.png",
    "https://example.com/a?b=1",
    "http://example.com/",
    "mailto:someone@example.com",
]


@unittest.skipUnless(HAVE_APP, "app import needs the container's dependencies")
class OffSiteAddresses(unittest.TestCase):
    def test_tricks_are_stripped_from_links_and_images(self):
        for v in BAD:
            out = sanitize_html(f'<a href="{v}">text</a><img src="{v}" alt="pic">')
            self.assertNotIn("href=", out, repr(v))
            self.assertNotIn("src=", out, repr(v))
            self.assertIn(">text</a>", out, repr(v))      # the link text stays
            self.assertIn('alt="pic"', out, repr(v))       # so does the image's other markup

    def test_local_web_and_mail_addresses_survive(self):
        for v in GOOD:
            out = sanitize_html(f'<a href="{v}">text</a><img src="{v}" alt="pic">')
            self.assertIn(f'href="{v}"', out, v)
            if not v.startswith("mailto:"):
                self.assertIn(f'src="{v}"', out, v)

    def test_markdown_goes_through_the_same_check(self):
        out = render_markdown("[a](//evil.com) [b](/\\evil.com) ![c](/\\/evil.com) [ok](/wiki/page)")
        self.assertNotIn("evil.com", out)
        self.assertIn('href="/wiki/page"', out)

    def test_other_attributes_are_unchanged(self):
        out = sanitize_html('<a href="https://example.com/" title="t" target="_blank" onclick="x()">l</a>'
                            '<img src="/uploads/x.png" alt="a" width="10" height="20" onerror="x()">')
        self.assertIn('title="t"', out)
        self.assertIn('rel="noopener noreferrer"', out)
        self.assertIn('width="10"', out)
        self.assertIn('height="20"', out)
        self.assertNotIn("onclick", out)
        self.assertNotIn("onerror", out)


if __name__ == "__main__":
    unittest.main()
