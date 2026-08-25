#!/usr/bin/env python3
"""Generate public/og-image.png — the social preview card.

Drawn rather than screenshotted, using the same palette and the same display
face as the site, so a link preview looks like the page it points at. Plan §5.2
governs this as much as it governs the stylesheet: no gradients, no glow, one
accent, and a lot of paper.

    python3 scripts/make-og-image.py
"""
from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
PAPER = (250, 247, 240)
INK = (28, 25, 23)
INK_SOFT = (87, 83, 78)
RULE = (221, 214, 201)
ACCENT = (140, 58, 43)

FONT = "public/fonts/fraunces-subset.woff2"

def face(size, variable=None):
    # Pillow reads the woff2 through FreeType; the variable axes default to the
    # regular instance, which is what the site uses for the display face.
    f = ImageFont.truetype(FONT, size)
    if variable is not None:
        try:
            f.set_variation_by_axes(variable)
        except Exception:
            pass
    return f

img = Image.new("RGB", (W, H), PAPER)
d = ImageDraw.Draw(img)

M = 88  # margin, on the 8px scale

def width(text, font):
    return d.textbbox((0, 0), text, font=font)[2]

def wrap(text, font, limit):
    """Greedy wrap, measured rather than guessed — the previous version guessed
    and the second line ran off the card."""
    words, lines, current = text.split(), [], ""
    for word in words:
        candidate = word if current == "" else f"{current} {word}"
        if width(candidate, font) <= limit:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines

CONTENT = W - 2 * M

# Eyebrow
small = face(23)
d.text((M, M), "EMBER  &  OAK", font=small, fill=INK_SOFT)
d.text((M, M + 36), "est. 2019 · Bandra", font=small, fill=INK_SOFT)

# The headline, in the display face, large and unhurried.
head = face(88)
d.text((M, M + 108), "Reservations,", font=head, fill=INK)
d.text((M, M + 108 + 100), "answered.", font=head, fill=ACCENT)

# Hairline
y = M + 108 + 100 + 126
d.line([(M, y), (W - M, y)], fill=RULE, width=2)

# The supporting line, wrapped to the content width rather than by eye.
body = face(30)
lines = wrap(
    "Press one button and talk. An AI host takes the booking, and a "
    "dependency-free engine decides whether the table exists.",
    body,
    CONTENT,
)
for i, line in enumerate(lines[:2]):
    d.text((M, y + 34 + i * 44), line, font=body, fill=INK_SOFT)

# Footer, placed below the deepest line the body could reach so the two can
# never collide however the copy wraps.
foot = face(25)
footer_y = max(y + 34 + 2 * 44 + 34, H - M - 30)
d.text((M, footer_y), "parshvak26.github.io/hostline", font=foot, fill=INK)

# A single accent rule down the left edge — the one flourish.
d.rectangle([(0, 0), (10, H)], fill=ACCENT)

img.save("public/og-image.png", optimize=True)
print("wrote public/og-image.png")
