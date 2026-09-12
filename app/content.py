"""
Markdown rendering and HTML sanitization.

Shared by news, wiki and the seeder. The allowlist below is the single
definition of what user-authored content may contain anywhere in the app;
widening it widens it everywhere, so change it deliberately.

Relative URLs ("/wiki/other-page", "/api/wiki/images/x.png") pass through
bleach untouched while "javascript:" hrefs are stripped, which is what makes
cross-linking and inline images work without a custom protocol list.
"""

import bleach
import markdown

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


def sanitize_html(html: str) -> str:
    """
    Sanitize HTML to prevent XSS attacks.
    Allows safe tags only.
    """
    return bleach.clean(
        html,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRIBUTES,
        strip=True,
    )


def render_markdown(content: str) -> str:
    """Render markdown to sanitized HTML."""
    html = markdown.markdown(content, extensions=['extra', 'codehilite'])
    return sanitize_html(html)
