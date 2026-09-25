"""
Markdown rendering and HTML sanitization.

Shared by news, wiki and the seeder. The allowlist below is the single
definition of what user-authored content may contain anywhere in the app;
widening it widens it everywhere, so change it deliberately.

Relative URLs ("/wiki/other-page", "/api/wiki/images/x.png") pass through
bleach untouched while "javascript:" hrefs are stripped, which is what makes
cross-linking and inline images work without a custom protocol list.
The one exception is an address that only looks local: see _off_site_trick.
"""

import re

import markdown
from bleach.html5lib_shim import Filter
from bleach.sanitizer import Cleaner

ALLOWED_TAGS = [
    'p', 'br', 'b', 'strong', 'i', 'em', 'u', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'a', 'code', 'pre', 'blockquote', 'hr',
    'img', 's', 'del', 'div', 'span', 'sub', 'sup',
    # Markdown's "extra" extension emits tables, and a guide that compares two
    # things will use one. Without these the table collapses to bare text.
    # Structural only, no attributes, so this does not widen the XSS surface.
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
]

ALLOWED_ATTRIBUTES = {
    'a': ['href', 'title', 'target', 'rel'],
    'img': ['src', 'alt', 'width', 'height'],
}

# The URL parser drops tabs and newlines anywhere and trims leading control
# characters and spaces, so they are removed before the checks below.
_URL_IGNORED = re.compile(r"[\t\n\r]")
_URL_LEADING = "".join(chr(c) for c in range(0x21))


def _off_site_trick(value: str) -> bool:
    """True for an address that reads like a local path but a browser sends
    to another site: protocol-relative ("//host") or containing a backslash
    anywhere (URL parsing treats "\\" as "/", so "/\\host" is host). No real
    address needs either, and bleach's protocol check lets both through."""
    v = _URL_IGNORED.sub("", value or "").lstrip(_URL_LEADING)
    return v.startswith("//") or "\\" in v


def _allow_attribute(tag: str, name: str, value: str) -> bool:
    """ALLOWED_ATTRIBUTES, plus: no off-site trick in href or src."""
    if name not in ALLOWED_ATTRIBUTES.get(tag, ()):
        return False
    if name in ("href", "src") and _off_site_trick(value):
        return False
    return True


class _LinkRelFilter(Filter):
    """Force rel="noopener noreferrer" on any <a> that carries ``target``.

    ``target`` is allowed on links (a wiki/news author may legitimately open a
    reference in a new tab), but a link opened with target="_blank" hands the
    opened page a live ``window.opener`` handle back to this one -- reverse
    tabnabbing. Any existing rel tokens are preserved; ``noopener`` and
    ``noreferrer`` are appended only if missing. Links without ``target`` are
    left exactly as bleach produced them.
    """

    def __iter__(self):
        for token in Filter.__iter__(self):
            if token.get("type") in ("StartTag", "EmptyTag") and token.get("name") == "a":
                attrs = token.get("data") or {}
                if any(name == "target" for (_ns, name) in attrs.keys()):
                    rels = (attrs.get((None, "rel"), "") or "").split()
                    for required in ("noopener", "noreferrer"):
                        if required not in rels:
                            rels.append(required)
                    attrs[(None, "rel")] = " ".join(rels)
                    token["data"] = attrs
            yield token


def sanitize_html(html: str) -> str:
    """
    Sanitize HTML to prevent XSS attacks.
    Allows safe tags only, drops link and image addresses that only look
    local (see _off_site_trick), and forces rel="noopener noreferrer" on any
    link that opens a new browsing context (target=...).
    """
    cleaner = Cleaner(
        tags=ALLOWED_TAGS,
        attributes=_allow_attribute,
        strip=True,
        filters=[_LinkRelFilter],
    )
    return cleaner.clean(html)


def render_markdown(content: str) -> str:
    """Render markdown to sanitized HTML."""
    html = markdown.markdown(content, extensions=['extra', 'codehilite'])
    return sanitize_html(html)
