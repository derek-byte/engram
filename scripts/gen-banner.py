#!/usr/bin/env python3
"""README title banner: pixel-bust logo + engram wordmark, same hand style and
white paper as docs/architecture.png.

Needs Pillow (background keying):  uv run --with pillow scripts/gen-banner.py docs/banner.png
"""
import base64
import io
import random
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parent.parent
ART = REPO / "app/src-tauri/icons/icon-art.png"
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else REPO / "docs/banner.png")

W, H = 2280, 360
INK = "#1e1e1e"
FONT = "Chalkboard SE, Chalkboard, Comic Sans MS, cursive"
rng = random.Random(4)


def w(v, amt=2.2):
    return v + rng.uniform(-amt, amt)


def wobble_line(x1, y1, x2, y2, amt=2.0):
    dx, dy = x2 - x1, y2 - y1
    L = max((dx * dx + dy * dy) ** 0.5, 1)
    nx, ny = -dy / L, dx / L
    j1, j2 = rng.uniform(-amt, amt), rng.uniform(-amt, amt)
    c1x, c1y = x1 + dx / 3 + nx * j1, y1 + dy / 3 + ny * j1
    c2x, c2y = x1 + 2 * dx / 3 + nx * j2, y1 + 2 * dy / 3 + ny * j2
    return f"M{w(x1,1.2):.1f},{w(y1,1.2):.1f} C{c1x:.1f},{c1y:.1f} {c2x:.1f},{c2y:.1f} {w(x2,1.2):.1f},{w(y2,1.2):.1f}"


def stroke(d, width=2.6):
    return (f'<path d="{d}" fill="none" stroke="{INK}" stroke-width="{width}" '
            f'stroke-linecap="round" opacity="0.92"/>')


def keyed_logo() -> tuple[str, int, int]:
    """Art with its paper background keyed to transparent, cropped to content."""
    im = Image.open(ART).convert("RGBA")
    px = im.load()
    lo, hi = 200, 238  # luminance ramp: opaque below lo, transparent above hi
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            if lum >= hi:
                px[x, y] = (r, g, b, 0)
            elif lum > lo:
                px[x, y] = (r, g, b, int(a * (hi - lum) / (hi - lo)))
    im = im.crop(im.getbbox())
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode(), im.width, im.height


art_b64, ART_W, ART_H = keyed_logo()
LOGO_H = 190
LOGO_W = LOGO_H * ART_W / ART_H

WORD_SIZE = 110
GAP = 52
word_w = WORD_SIZE * 0.62 * 6  # rough advance for 6 chalkboard glyphs
total = LOGO_W + GAP + word_w
x0 = (W - total) / 2
logo_y = (H - LOGO_H) / 2
word_cx = x0 + LOGO_W + GAP + word_w / 2
word_cy = H / 2

parts = [
    f'<image x="{x0:.0f}" y="{logo_y:.0f}" width="{LOGO_W:.0f}" height="{LOGO_H}" '
    f'href="data:image/png;base64,{art_b64}"/>',
    f'<text x="{word_cx:.0f}" y="{word_cy:.0f}" font-family="{FONT}" font-size="{WORD_SIZE}" '
    f'font-weight="bold" fill="{INK}" text-anchor="middle" dominant-baseline="middle">engram</text>',
]

# qlmanage fits the short side and crops square: square canvas, then sips-crop.
PAD_TOP = (W - H) / 2
svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{W}" viewBox="0 0 {W} {W}">',
       f'<rect width="{W}" height="{W}" fill="white"/>',
       f'<g transform="translate(0,{PAD_TOP})">'] + parts + ["</g></svg>"]

with tempfile.TemporaryDirectory() as td:
    src = Path(td) / "banner.svg"
    src.write_text("".join(svg))
    subprocess.run(["qlmanage", "-t", "-s", str(W), "-o", td, str(src)], check=True, capture_output=True)
    OUT.write_bytes((Path(td) / "banner.svg.png").read_bytes())
subprocess.run(["sips", "--cropToHeightWidth", str(H), str(W), str(OUT)], check=True, capture_output=True)
print(f"wrote {OUT}")
