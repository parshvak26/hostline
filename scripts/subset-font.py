#!/usr/bin/env python3
"""Regenerate public/fonts/fraunces-subset.woff2.

Fraunces ships as a variable font covering the full Latin range. The page uses
it for headings only, so 60% of that file is glyphs nobody will ever see. This
subsets it to the characters the copy can actually contain, which is what keeps
the font budget (plan §15: <60KB) reachable without giving up a variable axis.

Requires: fonttools with brotli (`pip install 'fonttools[woff]' brotli`).
Source: https://github.com/undercasetype/Fraunces  (SIL Open Font License 1.1)

Usage:
    curl -sL "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300..700&display=swap" \
      -H 'User-Agent: Mozilla/5.0 ... Chrome/120' -o /tmp/fraunces.css
    # take the `latin` @font-face src URL from that file, download it, then:
    python3 scripts/subset-font.py /tmp/fraunces-latin.woff2
"""
import sys
from fontTools import subset

CHARS = (
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "abcdefghijklmnopqrstuvwxyz"
    "0123456789"
    " .,:;!?'\"()[]&@#%/\\-—–…·°*+=<>"
    "’‘“”"
)

def main() -> None:
    src = sys.argv[1] if len(sys.argv) > 1 else "/tmp/fraunces-latin.woff2"
    dst = "public/fonts/fraunces-subset.woff2"

    opts = subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = [
        "kern", "liga", "calt", "onum", "lnum", "frac",
        "ccmp", "locl", "mark", "mkmk", "rlig",
    ]
    opts.name_IDs = ["*"]
    opts.name_legacy = True
    opts.notdef_outline = True
    opts.recalc_bounds = True
    opts.drop_tables += ["DSIG"]

    font = subset.load_font(src, opts)
    subsetter = subset.Subsetter(options=opts)
    subsetter.populate(text=CHARS)
    subsetter.subset(font)
    subset.save_font(font, dst, opts)
    print(f"wrote {dst}")

if __name__ == "__main__":
    main()
