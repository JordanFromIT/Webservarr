"""
Theme T2: every page uses the theme engine, so an operator's theme (a light
one included) reads correctly site-wide.

The colour scan (NoPaletteColours) reads html, js, pages.py and the routers
that serve HTML. Accepted limits, by ruling R168:
- It works line by line, so a CSS declaration or a class string split over
  several lines is only seen in the parts on each line.
- Object.assign(el.style, {...}) and other object-literal style writes are
  not covered; the site writes styles through class names, .style.<prop> =,
  setProperty(), cssText and style attributes, which are.
- A numeric URL fragment such as href="#2026" reads as a hex colour and fails
  loudly (R159); that is left as is.

Run inside the container:
    python -m unittest discover -s /app/app/tests -t /app -v
"""
import pathlib
import re
import unittest
from unittest import mock

from app.tests.test_shell_contract import STATIC

try:
    from fastapi.testclient import TestClient
    from app.main import app
    from app import pages
    from app.routers.branding import EMPTY_WIKI_HOOKS, build_branding
    from app.tests.test_page_gating import ADMIN_SESSION, PageRoutesBase
    HAVE_APP = True
except Exception:  # pragma: no cover - the laptop has no FastAPI
    HAVE_APP = False
    PageRoutesBase = unittest.TestCase
    ADMIN_SESSION = {}

REQUESTS = (STATIC / "requests.html").read_text(encoding="utf-8")

# ---- G1.2: no palette colour on text or surfaces ---------------------------
#
# Every colour on the site comes from the theme engine (theme-loader's CSS
# variables and the Tailwind names mapped onto them). A Tailwind palette
# colour (text-green-400, bg-black/80, hover:text-red-300, placeholder-slate-500,
# text-[#ff0000] ...) ignores the operator's theme, and on a light theme it is
# often unreadable. This scan keeps them from coming back.
PALETTE_NAMES = ("slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|"
                 "blue|indigo|violet|purple|fuchsia|pink|rose|white|black")
_VARIANTS = r"(?:[\w\[\]&-]+:)*"
TEXT_PALETTE = re.compile(r"(?<![\w-])(" + _VARIANTS + r"(?:text|placeholder)-(?:" + PALETTE_NAMES +
                          r")(?:-\d{2,3})?(?:/(?:\d+|\[[\d.]+\]))?)(?![\w-])")
SURFACE_PALETTE = re.compile(r"(?<![\w-])(" + _VARIANTS + r"(?:bg|border(?:-[trblxy])?|ring|ring-offset|from|via|to|fill|"
                             r"stroke|outline|divide|decoration|caret|accent)-(?:" + PALETTE_NAMES +
                             r")(?:-\d{2,3})?(?:/(?:\d+|\[[\d.]+\]))?)(?![\w-])")
# The CSS Color 4 named colours (148 keywords). transparent and currentcolor
# are not colours of their own and stay allowed.
CSS_COLOUR_NAMES = (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood "
    "cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray "
    "darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen "
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue "
    "firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew "
    "hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan "
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray "
    "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue "
    "mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred "
    "midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid "
    "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple "
    "rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue "
    "slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white "
    "whitesmoke yellow yellowgreen"
).split()
NAMED_COLOURS = "|".join(sorted(CSS_COLOUR_NAMES, key=len, reverse=True))
# Arbitrary values on a colour utility: a hex, an rgb()/hsl() literal (one
# built on a theme variable, rgb(var(--...)), is fine) or a named colour.
ARBITRARY_COLOUR = re.compile(r"(?<![\w-])(" + _VARIANTS + r"(?:text|placeholder|bg|border(?:-[trblxy])?|ring|ring-offset|"
                              r"from|via|to|fill|stroke|outline|decoration|shadow|divide|caret|accent)-\[(?:color:)?"
                              r"(?:#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?)\((?!\s*var\()[^\]]*\)|(?i:" + NAMED_COLOURS + r"))\])")
# A named colour where CSS takes a colour. Each place a colour can go is
# found first, then every named colour in it is reported:
# - the value of a colour property (color, background, border*, outline*,
#   fill, stroke, caret/accent/decoration colours, shadows) or of any custom
#   property (--accent-color: tomato), in a style attribute, a page <style>
#   block or a style string in JS (cssText, setAttribute('style', ...));
# - the string assigned to .style.<colour prop>, or given to setProperty()
#   for a colour or custom property;
# - a Tailwind arbitrary property ([color:crimson], [--x:red]);
# - the whole of a color-mix(...) call, nested parentheses included.
# Anchored on those places, so prose ("the red carpet", "requested",
# white-space, border-radius) never matches.
_COLOUR_PROPS = (r"color|background(?:-color)?|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?"
                 r"|outline(?:-color)?|fill|stroke|caret-color|accent-color|text-decoration(?:-color)?|column-rule(?:-color)?"
                 r"|box-shadow|text-shadow")
_JS_COLOUR_PROPS = (r"color|background(?:Color)?|border(?:Top|Right|Bottom|Left)?(?:Color)?|outline(?:Color)?|fill|stroke"
                    r"|caretColor|accentColor|textDecorationColor|boxShadow|textShadow")
_CSS_DECL = re.compile(r"(?i)(?:^|[\s;{\"'`(])(?:" + _COLOUR_PROPS + r"|--[\w-]+)\s*:\s*([^;\"'`}]*)")
_JS_STYLE = re.compile(r"(?i)\.style\.(?:" + _JS_COLOUR_PROPS + r")\s*=\s*([\"'`])(.*?)\1")
_SET_PROPERTY = re.compile(r"(?i)setProperty\(\s*([\"'])([\w-]+)\1\s*,\s*([\"'])(.*?)\3")
_TW_PROPERTY = re.compile(r"(?i)\[(?:" + _COLOUR_PROPS + r"|--[\w-]+):([^\]]*)\]")
_COLOUR_WORD = re.compile(r"(?i)(?<![A-Za-z0-9-])(" + NAMED_COLOURS + r")(?![A-Za-z0-9-])")
_COLOURISH_PROP = re.compile(r"(?i)^(?:--.*|.*(?:color|background|fill|stroke|shadow|border|outline).*)$")


def _balanced(line, open_paren):
    """The text inside the parentheses that open at open_paren."""
    depth = 0
    for i in range(open_paren, len(line)):
        if line[i] == "(":
            depth += 1
        elif line[i] == ")":
            depth -= 1
            if depth == 0:
                return open_paren + 1, i
    return open_paren + 1, len(line)


def named_colour_hits(line):
    """Every named colour sitting where CSS takes a colour, in line order."""
    spans = []
    for m in _CSS_DECL.finditer(line):
        spans.append(m.span(1))
    for m in _JS_STYLE.finditer(line):
        spans.append(m.span(2))
    for m in _SET_PROPERTY.finditer(line):
        if _COLOURISH_PROP.match(m.group(2)):
            spans.append(m.span(4))
    for m in _TW_PROPERTY.finditer(line):
        spans.append(m.span(1))
    for m in re.finditer(r"(?i)color-mix\(", line):
        spans.append(_balanced(line, m.end() - 1))
    found = {}
    for a, b in spans:
        for w in _COLOUR_WORD.finditer(line, a, b):
            found[w.start()] = w.group(1)
    return [found[k] for k in sorted(found)]


# A raw colour literal anywhere in markup, page styles, scripts or a router's
# HTML: a hex, or rgb()/hsl() with numbers in it. A theme variable wrapped in
# rgb() is not a literal, nor is a hex that is only var()'s fallback.
# theme.css is not swept: the engine's own defaults live there.
RAW_COLOUR = re.compile(r"(?<![\w&#/-])(#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])"
                        r"|\b(?:rgba?|hsla?)\(\s*[\d.][^)]*\))")

# The only sanctioned exceptions (audit M10): the Plex sign-in buttons wear
# Plex's own brand colours. Each entry is (file, class, a snippet that marks
# the line), so a new use elsewhere, even of the same class, still fails.
M10_ALLOWED = {
    ("login.html", "text-black", 'id="plexLoginBtn"'),
    ("login.html", "text-black", 'id="authentikLoginBtn"'),
    ("login.html", "bg-[#E5A00D]", 'id="plexLoginBtn"'),
    ("login.html", "bg-[#E5A00D]", 'id="authentikLoginBtn"'),
    ("login.html", "hover:bg-[#cc8f0c]", 'id="plexLoginBtn"'),
    ("login.html", "hover:bg-[#cc8f0c]", 'id="authentikLoginBtn"'),
}


# Raw colour literals that are allowed, each by (file, a snippet marking the
# line, the literal itself, why). Only that literal on that line is exempt:
# a second colour added to an allowed line still fails.
RAW_ALLOWED = {
    ("login.html", 'id="plexLoginBtn"', "#E5A00D", "M10: Plex's brand colour on its sign-in button"),
    ("login.html", 'id="plexLoginBtn"', "#cc8f0c", "M10: Plex's brand colour (hover) on its sign-in button"),
    ("login.html", 'id="authentikLoginBtn"', "#E5A00D", "M10: Plex's brand colour on its sign-in button"),
    ("login.html", 'id="authentikLoginBtn"', "#cc8f0c", "M10: Plex's brand colour (hover) on its sign-in button"),
    ("reader.html", "light: { bg:", "#FBFAF7", "M10: the light reading mode's page"),
    ("reader.html", "light: { bg:", "#1A1A1A", "M10: the light reading mode's text"),
    ("reader.html", "sepia: { bg:", "#F4ECD8", "M10: the sepia reading mode's page"),
    ("reader.html", "sepia: { bg:", "#4A3B28", "M10: the sepia reading mode's text"),
    ("reader.html", "dark:  { bg:", "#111315", "M10: the dark reading mode's page"),
    ("reader.html", "dark:  { bg:", "#D6D6D6", "M10: the dark reading mode's text"),
    ("reader.html", "black: { bg:", "#000000", "M10: the black reading mode's page"),
    ("reader.html", "black: { bg:", "#C9CCD1", "M10: the black reading mode's text"),
    ("reader.html", "True #000 so OLED", "#000", "a comment explaining the black reading mode"),
    ("reader.html", "getPropertyValue('--hex-background') ||", "#000000", "the shipped default if the theme variable is missing"),
    ("reader.html", "getPropertyValue('--hex-text') ||", "#BEEEF4", "the shipped default if the theme variable is missing"),
    ("theme-loader.js", 'e.g. "#125793"', "#125793", "a comment showing the hex-to-triplet conversion"),
    ("requests.html", "measured against the button's #125793 fill", "#125793", "a comment about measured contrast"),
    ("pages.py", "'#125793' -> '18 87 147'", "#125793", "a docstring showing the hex-to-triplet conversion"),
}


def swept_files():
    files = sorted(set(STATIC.glob("**/*.html")) | set((STATIC / "js").glob("**/*.js")))
    routers = [p for p in sorted((STATIC.parent / "routers").glob("*.py"))
               if re.search(r"HTMLResponse|text/html", p.read_text(encoding="utf-8"))]
    return files + [STATIC.parent / "pages.py"] + routers


def raw_line_hits(name, line):
    """The raw and named colours on one line that no allowance covers."""
    hits = []
    for m in RAW_COLOUR.finditer(line):
        if re.search(r"var\(--[\w-]+,\s*$", line[:m.start()]):
            continue
        lit = m.group(1)
        if any(name == f and mark in line and lit.lower() == allowed.lower() for f, mark, allowed, _why in RAW_ALLOWED):
            continue
        hits.append(lit)
    hits.extend(named_colour_hits(line))
    return hits


def raw_hits():
    hits = []
    for path in swept_files():
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for lit in raw_line_hits(path.name, line):
                hits.append(f"{path.relative_to(STATIC.parent)}:{n}: {lit}")
    return hits


def palette_hits(pattern):
    hits = []
    for path in swept_files():
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for m in pattern.finditer(line):
                cls = m.group(1)
                if any(path.name == f and cls == c and mark in line for f, c, mark in M10_ALLOWED):
                    continue
                hits.append(f"{path.relative_to(STATIC.parent)}:{n}: {cls}")
    return hits
ISSUES = (STATIC / "issues.html").read_text(encoding="utf-8")


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class PlexPopupPageIsThemed(unittest.TestCase):
    """L9: the page the Plex popup lands on was bare HTML (black on white).
    It now carries the operator's colours, font and custom CSS like every
    other page, and still hands the sign-in back to the opener."""

    def fetch(self, values):
        b = build_branding(values, {}, None, dict(EMPTY_WIKI_HOOKS))
        with mock.patch.object(pages, "load_context", return_value=(b, {"netdata": False})) as ctx:
            r = TestClient(app).get("/auth/plex-callback-page")
        ctx.assert_called_once_with(False)   # public branding only
        return r

    def test_it_wears_the_operators_theme(self):
        r = self.fetch({"theme.color_background": "#F8FAFC", "theme.color_text": "#0F172A",
                        "theme.custom_css": "p { letter-spacing: 1px; }"})
        self.assertEqual(r.status_code, 200)
        body = r.text
        self.assertIn('<style id="ws-theme">:root{', body)
        self.assertIn("--color-background:248 250 252", body)
        self.assertIn("--color-text:15 23 42", body)
        self.assertIn('<script id="ws-data" type="application/json">', body)
        self.assertIn('<script src="/static/js/theme-loader.js"></script>', body)
        self.assertIn('<link href="/static/css/theme.css" rel="stylesheet">', body)
        self.assertIn("background: rgb(var(--color-background))", body)
        self.assertIn("color: rgb(var(--color-text) / .7)", body)
        head = body.split("</head>", 1)[0]
        self.assertTrue(head.rstrip().endswith("p { letter-spacing: 1px; }</style>"),
                        "the custom CSS is the last thing in <head>")
        self.assertLess(head.index("theme.css"), head.index('id="webservarr-custom-css"'))

    def test_generic_copy_and_the_handoff_still_work(self):
        body = self.fetch({}).text
        self.assertIn("Signing you in", body)
        self.assertNotIn("Plex Auth", body)
        self.assertIn("window.opener.postMessage({type: 'plex-auth-complete'}, ", body)
        self.assertIn("window.location.href = '/login?plex_auth=complete';", body)
        self.assertNotIn("webservarr-custom-css", body)   # none saved, none written

    def test_the_handoff_never_waits_on_a_stylesheet(self):
        # R148: a pending stylesheet holds back every classic script after it,
        # so the hand-back script comes before all of them, needs no body
        # element, and the page loads no web font at all.
        body = self.fetch({"theme.custom_css": "p { color: inherit; }"}).text
        handoff = body.index("window.opener.postMessage(")
        head = body.split("</head>", 1)[0]
        self.assertLess(handoff, len(head), "the hand-back script is in <head>")
        for later in ('rel="stylesheet"', "<script src=", "<style", 'id="webservarr-custom-css"'):
            for m in re.finditer(re.escape(later), body):
                self.assertLess(handoff, m.start(), later)
        self.assertNotIn("fonts.googleapis.com", body)
        self.assertNotIn("fonts.gstatic.com", body)
        self.assertNotIn("getElementById", body[:handoff + 400])

    def test_it_is_rate_limited(self):
        from app.routers import plex_auth
        src = pathlib.Path(plex_auth.__file__).read_text(encoding="utf-8")
        self.assertRegex(src, r'@router\.get\("/plex-callback-page"\)\n@limiter\.limit\("60/minute"\)\n'
                              r'async def plex_callback_page\(request: Request\)')


@unittest.skipUnless(HAVE_APP, "needs the app's dependencies")
class RequestStatusNeverMovesThePage(PageRoutesBase):
    """O2: Request Status was shown at first paint and hidden once its data
    said nothing was waiting, which pulled the rest of the page up. The
    server now collapses it from the first paint when the cached snapshot,
    the same one the section's API returns, has nothing to show."""

    def html_tag(self, snapshot):
        with mock.patch("app.services.request_status.get_cached_snapshot",
                        mock.AsyncMock(return_value=snapshot)):
            r = self.get("/requests", ADMIN_SESSION)
        self.assertEqual(r.status_code, 200)
        return re.search(r"<html\b[^>]*>", r.text).group(0)

    def test_collapsed_when_nothing_is_waiting_or_it_is_unavailable(self):
        self.assertIn(" data-rs-empty", self.html_tag({"items": [], "total": 0}))
        self.assertIn(" data-rs-empty", self.html_tag({"error": "unavailable", "items": []}))

    def test_left_to_the_page_when_rows_exist_or_the_cache_is_cold(self):
        self.assertNotIn("data-rs-empty", self.html_tag({"items": [{"id": 1}], "total": 1}))
        self.assertNotIn("data-rs-empty", self.html_tag(None))


class RequestStatusCollapseMarkup(unittest.TestCase):
    def test_the_mark_hides_the_section_and_rows_lift_it(self):
        head = REQUESTS.split("</head>", 1)[0]
        self.assertIn("html[data-rs-empty] #rsSection { display: none; }", head)
        load = re.search(r"async function load\(user\) \{(.*?)\n  \}\n", REQUESTS, re.S).group(1)
        rows = load.index("if (!_rows.length)")
        self.assertGreater(load.index("document.documentElement.removeAttribute('data-rs-empty');"), rows)

    def test_the_early_discover_markup_has_no_inline_handlers(self):
        # R151: scrollDiscoverRow is defined in the last script, so an inline
        # onclick baked in before it threw a ReferenceError on an early click.
        self.assertNotIn('onclick="scrollDiscoverRow', REQUESTS)
        wire = re.search(r"function buildDiscoverSection\(\) \{(.*?)\n\}", REQUESTS, re.S).group(1)
        self.assertIn("addEventListener('click', function () { scrollDiscoverRow(row.id, -1); })", wire)
        self.assertIn("addEventListener('click', function () { scrollDiscoverRow(row.id, 1); })", wire)

    def test_discover_rows_and_skeletons_are_in_the_first_paint(self):
        # With Request Status collapsed, the discover rows lead the page; built
        # after the page scripts loaded, they pushed everything below down.
        written = REQUESTS.index("document.getElementById('discoverSection').innerHTML = html;")
        self.assertLess(REQUESTS.index('<div id="discoverSection"'), written)
        self.assertLess(written, REQUESTS.index('<script src="/static/js/auth.js'))
        # The skeleton card is the real card's box: its border, poster, badge and title lines.
        skel = re.search(r"function buildDiscoverSkeletons\(\) \{(.*?)\n\}", REQUESTS, re.S).group(1)
        card = re.search(r"function buildDiscoverCard\(item\) \{(.*?)\n\}", REQUESTS, re.S).group(1)
        for token in ("shrink-0 w-28 rounded-xl", "aspect-[2/3]", "p-1.5",
                      "inline-block text-[8px] font-bold px-1 py-0.5 rounded mb-1",
                      "text-[11px] font-medium leading-tight truncate"):
            self.assertIn(token, skel, token)
            self.assertIn(token, card, token)
        self.assertIn("border border-transparent", skel)   # the glass card's 1px border
        self.assertIn("glass-card", card)


class PageStylesAreInTheHead(unittest.TestCase):
    """Item 13: a page's own <style> sits in <head>, before the custom CSS
    the server writes last, so the operator's CSS wins at equal specificity."""

    def test_no_style_block_in_the_body(self):
        for name, text in (("requests", REQUESTS), ("issues", ISSUES)):
            head, body = text.split("</head>", 1)
            self.assertIn("<style>", head, name)
            self.assertNotIn("<style", body, name)



# Bright text is the colour for words on a solid Primary fill. Anywhere else a
# light theme turns it white on white. These uses sit on Primary without
# naming bg-primary on the same line; every other use must name it.
BRIGHT_ON_PRIMARY = {
    ("tour.js", 'id="tourIcon"', "the tour bubble (.tour-bubble, Primary at .96)"),
    ("tour.js", 'id="tourTitle"', "the tour bubble"),
    ("tour.js", 'id="tourSkip"', "the tour bubble"),
    ("tour.js", 'id="tourBody"', "the tour bubble"),
    ("tour.js", 'id="tourBack"', "the tour bubble"),
    ("pages.py", 'subcls="text-bright/80" if active', "the active nav pill (_LINK_ACTIVE, bg-primary)"),
    ("pages.py", "text-bright font-bold text-3xl", "the logo-fallback tile (size-14 bg-primary)"),
    ("pages.py", "text-bright text-xl", "the phone bar's logo-fallback tile (size-8 bg-primary)"),
}
BRIGHT = re.compile(r"(?<![\w-])(?:[\w:-]+:)?text-bright(?:/\d+)?(?![\w-])")
ON_PRIMARY = re.compile(r"(?<![\w/:-])bg-primary(?![\w/:-])")


def class_string(line, pos):
    """The quoted string a match sits in: from the nearest quote before it to
    the nearest quote after it (any of " ' `), so one class attribute or one
    JS class string, however the source splits it across literals."""
    starts = [line.rfind(q, 0, pos) for q in "\"'`"]
    ends = [e for e in (line.find(q, pos) for q in "\"'`") if e != -1]
    return line[max(starts) + 1:(min(ends) if ends else len(line))]


def own_tag(line, pos):
    """The tag the match sits in (from its '<' to its '>'), or the whole line
    when it is not inside a tag on this line (a Python class variable)."""
    lt, gt = line.rfind("<", 0, pos), line.find(">", pos)
    if lt != -1 and gt != -1 and line.rfind(">", 0, pos) < lt:
        return line[lt:gt + 1]
    return line


def bright_line_hits(name, line):
    hits = []
    for m in BRIGHT.finditer(line):
        if ON_PRIMARY.search(class_string(line, m.start())):
            continue
        tag = own_tag(line, m.start())
        if any(name == f and mark in tag for f, mark, _where in BRIGHT_ON_PRIMARY):
            continue
        hits.append(m.group(0))
    return hits


class BrightTextOnlyOnPrimary(unittest.TestCase):
    """R153/R158: Bright text (text-bright, hover:text-bright) only on a
    Primary fill: in the same class string as bg-primary, or in a tag the
    allowlist names with its Primary surface."""

    def test_every_bright_use_is_on_primary(self):
        stray = []
        for path in swept_files():
            for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                for cls in bright_line_hits(path.name, line):
                    stray.append(f"{path.relative_to(STATIC.parent)}:{n}: {cls}")
        self.assertEqual(stray, [])

    def test_the_check_is_per_class_string(self):
        self.assertEqual(bright_line_hits("x.html", '<span class="bg-primary">x</span><span class="text-bright">y</span>'),
                         ["text-bright"])
        self.assertEqual(bright_line_hits("x.html", '<button class="bg-primary text-bright">Go</button>'), [])
        self.assertEqual(bright_line_hits("x.js", "createEl('b', 'px-3 bg-primary hover:bg-primary/80 text-bright')"), [])
        self.assertEqual(bright_line_hits("x.html", '<b class="bg-primary/20 text-bright">z</b>'), ["text-bright"])
        self.assertEqual(bright_line_hits("x.html", '<a class="hover:text-bright" href="#">z</a>'), ["hover:text-bright"])
        # An allowlist marker elsewhere on the line doesn't cover a different tag.
        line = '<span id="tourIcon" class="text-bright">i</span><span class="text-bright">x</span>'
        self.assertEqual(bright_line_hits("tour.js", line), ["text-bright"])
        self.assertEqual(bright_line_hits("tour.js", '<span id="tourIcon" class="text-bright">i</span>'), [])

    def test_the_modal_close_buttons(self):
        tickets = (STATIC / "tickets.html").read_text(encoding="utf-8")
        calendar = (STATIC / "calendar.html").read_text(encoding="utf-8")
        for page, call in ((ISSUES, 'onclick="closeModal()" class="absolute top-3 right-3 text-steel-blue hover:text-frosted-blue'),
                           (tickets, 'onclick="closeCreateModal()" class="absolute top-3 right-3 text-steel-blue hover:text-frosted-blue'),
                           (tickets, 'onclick="closeDetailModal()" class="absolute top-3 right-3 text-steel-blue hover:text-frosted-blue'),
                           (calendar, 'id="closePanelBtn" class="absolute top-3 right-3 text-steel-blue hover:text-frosted-blue')):
            self.assertIn(call, page)


class BackdropClosesTheModal(unittest.TestCase):
    """R154: the scrim covers the whole wrapper, so it is the scrim that
    closes the modal (a click on the wrapper itself can never happen)."""

    def test_the_scrim_closes(self):
        tickets = (STATIC / "tickets.html").read_text(encoding="utf-8")
        for page, modal, close in ((ISSUES, "issueModal", "closeModal()"), (tickets, "createModal", "closeCreateModal()"),
                                   (tickets, "detailModal", "closeDetailModal()")):
            m = re.search(r'<div id="' + modal + r'" class="([^"]*)"( onclick="[^"]*")?>\n<div class="absolute inset-0 ws-scrim '
                          r'backdrop-blur-sm" onclick="' + re.escape(close) + r'"></div>', page)
            self.assertIsNotNone(m, modal)
            self.assertIsNone(m.group(2), modal + ": the wrapper's own handler could never fire")


TICKETS = (STATIC / "tickets.html").read_text(encoding="utf-8")


def js_function(src, head):
    """The body of the function assigned or declared with this head."""
    start = src.index(head)
    m = re.compile(r"\n  \};?\n").search(src, start)
    return src[start:m.end()]


class TicketDraftsSurvive(unittest.TestCase):
    """R160: a tap outside a ticket modal closes it (R154), so it must not
    throw away what was typed. The new-ticket form keeps its fields until a
    successful submit, and each ticket keeps its unsent comment."""

    def test_opening_the_form_keeps_the_draft(self):
        opener = js_function(TICKETS, "window.openCreateModal = function() {")
        self.assertNotIn(".value = ''", opener)
        self.assertNotIn("resetCreateForm", opener)

    def test_only_a_successful_submit_clears_it(self):
        reset = js_function(TICKETS, "function resetCreateForm() {")
        for field in ("createTitle", "createDescription", "createImage"):
            self.assertIn(f"document.getElementById('{field}').value = ''", reset)
        submit = js_function(TICKETS, "window.submitNewTicket = function() {")
        ok = submit[submit.index(".then(function() {"):submit.index(".catch(")]
        self.assertIn("resetCreateForm();", ok)
        self.assertEqual(TICKETS.count("resetCreateForm();"), 1)

    def test_comment_drafts_are_kept_per_ticket(self):
        self.assertIn("var _commentDrafts = {};", TICKETS)
        self.assertIn("textarea.value = _commentDrafts[ticket.id] || '';", TICKETS)
        self.assertIn("_commentDrafts[ticket.id] = textarea.value;", TICKETS)
        posted = TICKETS[TICKETS.index("postTicketForm('/api/tickets/' + ticket.id + '/comments'"):]
        ok = posted[posted.index(".then(function() {"):posted.index(".catch(")]
        self.assertIn("delete _commentDrafts[ticket.id];", ok)


class EscapeClosesTheModals(unittest.TestCase):
    """R161: Escape closes the issue and ticket modals like every other
    overlay: only the topmost, and never under a WSUI dialog."""

    def test_issues(self):
        m = re.search(r"document\.addEventListener\('keydown', function\(e\) \{(.*?)\n\}\);", ISSUES, re.S)
        self.assertIsNotNone(m)
        self.assertIn("e.key !== 'Escape' || e.isComposing || document.querySelector('.ws-dialog')", m.group(1))
        self.assertIn("closeModal()", m.group(1))

    def test_tickets_topmost_first(self):
        m = re.search(r"document\.addEventListener\('keydown', function\(e\) \{(.*?)\n  \}\);", TICKETS, re.S)
        self.assertIsNotNone(m)
        body = m.group(1)
        self.assertIn("e.key !== 'Escape' || e.isComposing || document.querySelector('.ws-dialog')", body)
        order = [body.index(c) for c in ("closeLightbox()", "closeDetailModal()", "closeCreateModal()")]
        self.assertEqual(order, sorted(order))
        self.assertEqual(body.count("else if"), 2)   # one overlay per key press


class TicketSendsSurviveAReopen(unittest.TestCase):
    """R165/R166: a ticket closed and reopened while its send is on the way.
    A rebuilt comment box waits for the pending post (no second send), and a
    success clears or closes only what still holds the sent text."""

    def comment_send(self):
        start = TICKETS.index("sendBtn.addEventListener('click', function() {")
        return TICKETS[start:TICKETS.index("formDiv.appendChild(textarea);", start)]

    def test_the_comment_send_is_tracked_per_ticket(self):
        self.assertIn("var _commentSending = {};", TICKETS)
        render = TICKETS[TICKETS.index("sendBtn.id = 'commentSendBtn';"):TICKETS.index("sendBtn.addEventListener('click'")]
        self.assertIn("sendBtn.setAttribute('data-ticket-id', String(ticket.id));", render)
        self.assertRegex(render, r"hasOwnProperty\.call\(_commentSending, ticket\.id\)\) \{\s*sendBtn\.disabled = true;"
                                 r"\s*sendBtn\.textContent = 'Sending\.\.\.';")
        send = self.comment_send()
        self.assertRegex(send, r"if \(_ticketsOff\) return;\s*if \(Object\.prototype\.hasOwnProperty\.call\(_commentSending, "
                               r"ticket\.id\)\) return;")
        self.assertIn("_commentSending[ticket.id] = msg;", send)
        settle = send[send.index(".finally("):]
        self.assertIn("delete _commentSending[ticket.id];", settle)
        self.assertIn("live.getAttribute('data-ticket-id') === String(ticket.id)", settle)
        self.assertIn("live.disabled = _ticketsOff;", settle)

    def test_success_clears_only_the_sent_comment(self):
        ok = self.comment_send()
        ok = ok[ok.index(".then(function() {"):ok.index(".catch(")]
        self.assertIn("if (_commentDrafts[ticket.id] === sent) delete _commentDrafts[ticket.id];", ok)
        self.assertIn("if (detailShowing(ticket.id)) openDetailModal(ticket.id);", ok)

    def test_a_late_new_ticket_success_leaves_a_newer_draft(self):
        submit = js_function(TICKETS, "window.submitNewTicket = function() {")
        ok = submit[submit.index(".then(function() {"):submit.index(".catch(")]
        guard = ok.index("document.getElementById('createTitle').value.trim() === title")
        self.assertLess(guard, ok.index("resetCreateForm();"))
        self.assertLess(guard, ok.index("closeCreateModal();"))
        self.assertIn("document.getElementById('createDescription').value.trim() === description", ok)
        self.assertIn("showToast('Ticket submitted!', 'success');", ok)


class EscapeWaitsForTheInputMethod(unittest.TestCase):
    """R167: Escape mid-composition cancels the composition, not the modal."""

    def test_wsui(self):
        ui = (STATIC / "js" / "ui.js").read_text(encoding="utf-8")
        self.assertIn("if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); d.close(d.dismiss); return; }", ui)


class HomeAndEbooksDetails(unittest.TestCase):
    """R150: small Home and eBooks fixes."""

    def test_them(self):
        home = (STATIC / "index.html").read_text(encoding="utf-8")
        clamp = "${Math.min(100, Math.max(0, Math.round(progress) || 0))}%"
        self.assertEqual(home.count(clamp), 2)          # the label and the bar
        self.assertNotIn("${Math.round(progress)}%", home)
        self.assertNotIn("generateStatusBars", home)
        library = (STATIC / "library.html").read_text(encoding="utf-8")
        self.assertIn("placeholder:text-frosted-blue/70", library)
        self.assertNotIn("placeholder:text-frosted-blue/60", library)


class FormControlsFollowTheTheme(unittest.TestCase):
    """L6: the forms plugin's grey chevron, blue focus ring and checkbox, and
    white ring offset are replaced by theme colours, at the plugin's own
    specificity so a page's utility classes still win."""

    THEME = (STATIC / "css" / "theme.css").read_text(encoding="utf-8")

    def rule(self, selector):
        m = re.search(re.escape(selector) + r" \{([^}]*)\}", self.THEME)
        self.assertIsNotNone(m, selector)
        return m.group(1)

    def test_chevron_focus_checkbox_and_placeholder(self):
        chevron = self.rule("select:where(:not([multiple]))")
        self.assertIn("rgb(var(--color-text) / .6)", chevron)
        self.assertNotIn("url(", chevron)
        focus = self.rule("input:focus, textarea:focus, select:focus")
        self.assertIn("--tw-ring-color: rgb(var(--color-primary))", focus)
        self.assertIn("--tw-ring-offset-color: rgb(var(--color-background))", focus)
        self.assertIn("color: rgb(var(--color-primary))", self.rule("input:where([type='checkbox'], [type='radio'])"))
        self.assertIn("color: rgb(var(--color-text) / .7)", self.rule("input::placeholder, textarea::placeholder"))

    def test_the_preference_toggles_hide_the_plugin_border(self):
        notif = (STATIC / "js" / "notifications.js").read_text(encoding="utf-8")
        self.assertEqual(notif.count("appearance:none; -webkit-appearance:none; border-color:transparent;"), 2)



class NoPaletteColours(unittest.TestCase):
    """G1.2 (R139): after the sweep, no text anywhere uses a colour outside
    the theme engine, and no surface or mark is a fixed palette colour. The
    only exceptions are the Plex brand buttons (M10)."""

    def test_the_scan_sees_the_whole_site(self):
        names = {p.name for p in swept_files()}
        for must in ("index.html", "login.html", "shell-sidebar.html", "notifications.js", "kit.js", "pages.py",
                     "plex_auth.py", "setup.py"):
            self.assertIn(must, names)

    def test_the_patterns_catch_what_they_should(self):
        for bad in ("text-green-400", "hover:text-red-300", "placeholder-slate-500", "placeholder:text-gray-400",
                    "text-white", "sm:text-yellow-300/80", "text-blue-500/[0.5]"):
            self.assertRegex(" " + bad + " ", TEXT_PALETTE, bad)
        for bad in ("bg-black/80", "from-black", "to-black", "border-red-500/30", "ring-black/60", "hover:bg-black"):
            self.assertRegex(" " + bad + " ", SURFACE_PALETTE, bad)
        for bad in ("text-[#ff0000]", "bg-[red]", "hover:text-[white]", "bg-[rgb(255,0,0)]", "border-[hsl(0_100%_50%)]",
                    "text-[color:#123]", "ring-[rgba(0,0,0,.5)]"):
            self.assertRegex(" " + bad + " ", ARBITRARY_COLOUR, bad)
        for ok in ("ring-[rgb(var(--ws-status-err))]", "text-[13px]", "bg-frosted-blue/[0.04]", "text-[color:var(--x)]"):
            self.assertNotRegex(" " + ok + " ", ARBITRARY_COLOUR, ok)
        for bad in ('style="color: #fff"', "color: rgb(255, 0, 0);", "el.style.background = 'hsl(0, 0%, 0%)'",
                    "background: rgba(0,0,0,0.4)", "#123456"):
            self.assertRegex(bad, RAW_COLOUR, bad)
        for ok in ("rgb(var(--color-text) / .6)", 'href="#"', "&#123;", "#rsSection", "#appHeader"):
            self.assertNotRegex(ok, RAW_COLOUR, ok)
        for ok in ("text-frosted-blue", "text-status-err-text", "bg-background-dark/80", "text-bright",
                   "from-background-dark", "bg-status-ok/10", "shadow-black/40", "text-media-movie"):
            self.assertNotRegex(" " + ok + " ", TEXT_PALETTE, ok)
            self.assertNotRegex(" " + ok + " ", SURFACE_PALETTE, ok)

    def test_no_palette_text_colour(self):
        self.assertEqual(palette_hits(TEXT_PALETTE), [])

    def test_no_palette_surface_or_mark(self):
        self.assertEqual(palette_hits(SURFACE_PALETTE), [])

    def test_no_arbitrary_colour_value(self):
        self.assertEqual(palette_hits(ARBITRARY_COLOUR), [])

    def test_no_raw_colour_literal(self):
        self.assertEqual(raw_hits(), [])

    def test_a_var_fallback_is_not_a_literal(self):
        self.assertIsNotNone(RAW_COLOUR.search("var(--hex-text, #BEEEF4)"))   # the pattern sees it...
        self.assertTrue(re.search(r"var\(--[\w-]+,\s*$", "var(--hex-text, "))  # ...and raw_hits skips it

    def test_every_raw_allowance_is_still_needed(self):
        for f, mark, lit, why in RAW_ALLOWED:
            path = next(p for p in swept_files() if p.name == f)
            line = next((l for l in path.read_text(encoding="utf-8").splitlines() if mark in l), None)
            self.assertIsNotNone(line, f"{f}: {mark!r} no longer exists ({why})")
            found = [m.group(1).lower() for m in RAW_COLOUR.finditer(line)]
            self.assertIn(lit.lower(), found, f"{f}: {mark!r} no longer holds {lit} ({why})")

    def test_an_allowance_covers_only_its_own_literal(self):
        line = '<button id="plexLoginBtn" class="w-full bg-[#E5A00D] hover:bg-[#cc8f0c] text-black">'
        self.assertEqual(raw_line_hits("login.html", line), [])
        tampered = line.replace('text-black">', 'text-black" data-x="#ff0000">')
        self.assertEqual(raw_line_hits("login.html", tampered), ["#ff0000"])
        self.assertEqual(raw_line_hits("index.html", line), ["#E5A00D", "#cc8f0c"])   # other files: no allowance

    def test_named_colours_in_css_and_style_scripts(self):
        self.assertEqual(len(CSS_COLOUR_NAMES), 148)
        for bad, words in (('style="color: red"', ["red"]), ("el.style.color = 'red'", ["red"]),
                           ("setProperty('color','orangered')", ["orangered"]),
                           ("cssText = 'color: red; background: white;'", ["red", "white"]),
                           ("setAttribute('style','color: red')", ["red"]),
                           ("  border: 1px solid Crimson;", ["Crimson"]),
                           (".x { background-color: rebeccapurple }", ["rebeccapurple"]),
                           ('el.style.backgroundColor = "navy"', ["navy"]),
                           # R168: color-mix across nested parentheses, every colour in it
                           ("color-mix(in srgb, red 50%, blue)", ["red", "blue"]),
                           ("color-mix(in srgb, rgb(var(--x)) 25%, black)", ["black"]),
                           ("background: color-mix(in srgb, rgb(var(--a)) 40%, white)", ["white"]),
                           # named colours on custom properties
                           ("--accent-color: tomato;", ["tomato"]), ("  --color-danger: crimson", ["crimson"]),
                           ("root.setProperty('--glow', 'gold')", ["gold"]),
                           # Tailwind arbitrary properties
                           ('class="[color:crimson]"', ["crimson"]), ('<b class="p-2 [background:cornflowerblue]">', ["cornflowerblue"]),
                           ('class="[border:1px_solid_red]"', ["red"]), ('class="[--ring:navy]"', ["navy"])):
            self.assertEqual(named_colour_hits(bad), words, bad)
        for ok in ("var(--x, #fff)", "requested", "border-radius: 8px", "<p>the red carpet</p>", "color: transparent",
                   "color: currentColor", "color: rgb(var(--color-text) / .7)", "background: linear-gradient(to right, x)",
                   '<span class="text-bright">Red Dawn</span>', "status: 'declined'",
                   "title: 'Orange is the New Black'", "white-space: nowrap", "border-color: transparent",
                   "color: var(--x)", "--color-red-flag: 1", "color-mix(in srgb, rgb(var(--a)) 25%, rgb(var(--b)))",
                   "setProperty('--color-' + k, rgb)", "class=\"[width:12px]\"", "el.style.width = '10px'"):
            self.assertEqual(named_colour_hits(ok), [], ok)
        # raw_line_hits reports them too
        self.assertEqual(raw_line_hits("x.html", '<p style="color: red; background: color-mix(in srgb, blue 50%, white)">'),
                         ["red", "blue", "white"])

    def test_arbitrary_named_colour_values(self):
        for bad in ("text-[crimson]", "bg-[cornflowerblue]", "hover:text-[RebeccaPurple]", "border-[color:tomato]"):
            self.assertRegex(" " + bad + " ", ARBITRARY_COLOUR, bad)
        for ok in ("text-[13px]", "bg-[transparent]", "text-[currentColor]", "text-[color:var(--x)]"):
            self.assertNotRegex(" " + ok + " ", ARBITRARY_COLOUR, ok)

    def test_the_allowlist_is_only_the_m10_buttons(self):
        login = (STATIC / "login.html").read_text(encoding="utf-8")
        for _f, cls, mark in M10_ALLOWED:
            line = next(l for l in login.splitlines() if mark in l)
            self.assertIn(cls, line)


if __name__ == "__main__":
    unittest.main()
