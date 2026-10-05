#!/usr/bin/env python3
"""Build the trimmed Material Symbols Outlined icon font.

The site draws its icons with Google's Material Symbols Outlined font, by
ligature: the text "home" in that font paints the house glyph. The whole
font is over 1 MB, but the site only draws a couple of hundred icons, so this
script cuts it down to the names in

    app/static/fonts/material-symbols-outlined.icons.txt

and writes

    app/static/fonts/material-symbols-outlined.woff2   the trimmed font
    app/static/fonts/material-symbols-outlined.json    what it was built from
    app/tests/material_symbols_names.txt               every name the source
                                                       font knows (the tests
                                                       use it to spot icon
                                                       names in the code)

The source is the exact file Google Fonts serves for
family=Material+Symbols+Outlined:wght,FILL@100..700,0..1 (pinned below by
URL and SHA-256), so the trimmed font draws the same outlines. Only two
things are taken out: the icons not listed, and the weights below 400 (the
site draws icons at 400, and at 700 for the logo stand-in). The FILL axis is
kept whole: the current nav tab and the play buttons draw filled icons.

Needs fontTools and Brotli (build time only, not an app dependency):

    python3 -m venv /tmp/iconfont && /tmp/iconfont/bin/pip install fonttools brotli
    /tmp/iconfont/bin/python scripts/build_icon_font.py [--source FILE]

--source uses a local copy of the source font instead of downloading it. A
source with a different hash is refused unless --accept-new-source is given
(for a deliberate upgrade: update SOURCE_URL and SOURCE_SHA256 after).
"""

import argparse
import hashlib
import io
import json
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
FONT_DIR = ROOT / "app" / "static" / "fonts"
NAMES_FILE = FONT_DIR / "material-symbols-outlined.icons.txt"
OUT_FONT = FONT_DIR / "material-symbols-outlined.woff2"
OUT_MANIFEST = FONT_DIR / "material-symbols-outlined.json"
OUT_CATALOGUE = ROOT / "app" / "tests" / "material_symbols_names.txt"

SOURCE_URL = (
    "https://fonts.gstatic.com/s/materialsymbolsoutlined/v375/"
    "kJEPBvYX7BgnkSrUwT8OhrdQw4oELdPIeeII9v6oDMzBwG-RpA6RzaxHMPdY40KH8nGzv3fzfVJO1Q.woff2"
)
SOURCE_SHA256 = "7c6337e6f0b5d48cbc966d768d67bc160d33c8e84f332d1d1c984064e547e9c9"

# The weight range kept. 400 is every icon; 700 is the bold logo stand-in
# (app/pages.py). Nothing draws an icon lighter than 400.
WGHT_RANGE = (400, 700)


def read_names(path: pathlib.Path) -> list:
    """The icon names in the list file, in file order, without duplicates."""
    seen, names = set(), []
    for line in path.read_text(encoding="utf-8").splitlines():
        name = line.strip()
        if not name or name.startswith("#") or name in seen:
            continue
        seen.add(name)
        names.append(name)
    return names


def names_digest(names) -> str:
    """The list's identity, independent of order and comments (the tests
    compare it with the one recorded at build time)."""
    return hashlib.sha256("\n".join(sorted(set(names))).encode("utf-8")).hexdigest()


def _ligature_subtables(gsub):
    for lookup in gsub.table.LookupList.Lookup:
        for sub in lookup.SubTable:
            if sub.LookupType == 7:  # Extension: the real subtable is inside
                sub = sub.ExtSubTable
            if sub.LookupType == 4:
                yield sub


def ligature_names(font) -> dict:
    """{icon name: ligature glyph} for every icon the font draws."""
    char_of = {glyph: chr(code) for code, glyph in font.getBestCmap().items()}
    out = {}
    for sub in _ligature_subtables(font["GSUB"]):
        for first, ligatures in sub.ligatures.items():
            for lig in ligatures:
                parts = [first] + list(lig.Component)
                if all(p in char_of for p in parts):
                    out["".join(char_of[p] for p in parts)] = lig.LigGlyph
    return out


def _fill_swaps(font) -> dict:
    """{glyph: its filled form} from the font's single substitutions."""
    out = {}
    for lookup in font["GSUB"].table.LookupList.Lookup:
        for sub in lookup.SubTable:
            sub = sub.ExtSubTable if sub.LookupType == 7 else sub
            if sub.LookupType == 1:
                out.update(sub.mapping)
    return out


def build(source: bytes, names: list):
    from fontTools import subset
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer

    font = TTFont(io.BytesIO(source), recalcTimestamp=False)
    known = ligature_names(font)
    missing = [n for n in names if n not in known]
    if missing:
        sys.exit("Not Material Symbols names: " + ", ".join(missing))

    # Keep only the listed ligatures. The subsetter alone cannot trim this
    # font: every icon is made of letters, digits and "_", so any text keeps
    # every ligature reachable.
    keep = set(names)
    char_of = {glyph: chr(code) for code, glyph in font.getBestCmap().items()}
    for sub in _ligature_subtables(font["GSUB"]):
        for first in list(sub.ligatures):
            kept = [lig for lig in sub.ligatures[first]
                    if char_of.get(first, "") + "".join(char_of.get(c, "?") for c in lig.Component) in keep]
            if kept:
                sub.ligatures[first] = kept
            else:
                del sub.ligatures[first]

    options = subset.Options()
    options.layout_features = ["*"]       # rlig/rclt draw the icons; keep all
    options.name_IDs = ["*"]              # keep the copyright and licence names
    options.name_languages = ["*"]
    options.notdef_outline = True
    options.recalc_timestamp = False
    letters = sorted({ord(c) for n in names for c in n})
    glyphs = {known[n] for n in names}
    # The filled form of many icons is a separate glyph ("home.fill"), swapped
    # in by a substitution that only applies at FILL 1 (GSUB FeatureVariations).
    # The subsetter does not follow that path, so add those glyphs by hand.
    fill_in_source = _fill_swaps(font)
    glyphs |= {fill_in_source[g] for g in list(glyphs) if g in fill_in_source}
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=letters, glyphs=sorted(glyphs))
    subsetter.subset(font)

    font = instancer.instantiateVariableFont(font, {"wght": WGHT_RANGE})
    font.flavor = "woff2"
    font.recalcTimestamp = False
    out = io.BytesIO()
    font.save(out)

    # Check the result draws every listed icon.
    check = TTFont(io.BytesIO(out.getvalue()))
    drawn = ligature_names(check)
    lost = [n for n in names if n not in drawn]
    if lost:
        sys.exit("The trimmed font lost: " + ", ".join(lost))
    fills = _fill_swaps(check)
    lost_fill = [n for n in names if known[n] in fill_in_source and drawn[n] not in fills]
    if lost_fill:
        sys.exit("The trimmed font lost filled forms: " + ", ".join(lost_fill))
    axes = {a.axisTag: (a.minValue, a.maxValue) for a in check["fvar"].axes}
    return out.getvalue(), sorted(known), axes


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--source", type=pathlib.Path, help="a local copy of the source font")
    ap.add_argument("--accept-new-source", action="store_true",
                    help="build from a source whose hash differs from SOURCE_SHA256")
    args = ap.parse_args(argv)

    if args.source:
        source = args.source.read_bytes()
    else:
        req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            source = resp.read()
    digest = hashlib.sha256(source).hexdigest()
    if digest != SOURCE_SHA256 and not args.accept_new_source:
        sys.exit(f"Source font hash {digest} is not the pinned {SOURCE_SHA256}. "
                 "Pass --accept-new-source to build from it on purpose.")

    names = read_names(NAMES_FILE)
    woff2, catalogue, axes = build(source, names)

    OUT_FONT.write_bytes(woff2)
    OUT_CATALOGUE.write_text(
        "# Every icon name in the Material Symbols Outlined source font\n"
        "# (written by scripts/build_icon_font.py; do not edit).\n"
        + "\n".join(catalogue) + "\n", encoding="utf-8")
    OUT_MANIFEST.write_text(json.dumps({
        "source_url": SOURCE_URL,
        "source_sha256": digest,
        "icons": len(names),
        "names_sha256": names_digest(names),
        "woff2_sha256": hashlib.sha256(woff2).hexdigest(),
        "woff2_bytes": len(woff2),
        "axes": {tag: list(rng) for tag, rng in sorted(axes.items())},
    }, indent=2) + "\n", encoding="utf-8")
    print(f"{len(names)} icons, {len(woff2)} bytes (source {len(source)} bytes), axes {axes}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
