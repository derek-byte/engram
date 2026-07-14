#!/usr/bin/env python3
"""README title banner: pixel-bust logo + engram wordmark on a TRANSPARENT
background, in light and dark variants for GitHub's <picture> element.

Run:  uv run --with pillow scripts/gen-banner.py
Writes docs/banner-light.png and docs/banner-dark.png (2x for retina).
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
ART = REPO / "app/src-tauri/icons/icon-art.png"
FONT_PATH = "/System/Library/Fonts/Supplemental/ChalkboardSE.ttc"

SCALE = 2  # render at 2x, display at half via the img width attribute
BUST_H = 130 * SCALE
TEXT_SIZE = 92 * SCALE
GAP = 34 * SCALE
PAD = 8 * SCALE

INK = (30, 30, 30, 255)          # light-mode text
LIGHT = (230, 237, 243, 255)     # dark-mode text (GitHub dark fg)
BUST_DARK = (211, 190, 208, 255)  # dark-mode bust: light plum stipple


def bold_font(size: int) -> ImageFont.FreeTypeFont:
    for i in range(4):
        try:
            f = ImageFont.truetype(FONT_PATH, size, index=i)
        except OSError:
            break
        if "bold" in f.getname()[1].lower():
            return f
    return ImageFont.truetype(FONT_PATH, size, index=0)


def keyed_bust() -> Image.Image:
    """Art with its paper background keyed to transparent, cropped to content."""
    im = Image.open(ART).convert("RGBA")
    px = im.load()
    lo, hi = 200, 238
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            if lum >= hi:
                px[x, y] = (r, g, b, 0)
            elif lum > lo:
                px[x, y] = (r, g, b, int(a * (hi - lum) / (hi - lo)))
    im = im.crop(im.getbbox())
    return im.resize((round(im.width * BUST_H / im.height), BUST_H), Image.LANCZOS)


def recolor(im: Image.Image, rgb: tuple) -> Image.Image:
    out = im.copy()
    px = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = px[x, y]
            if a:
                px[x, y] = (rgb[0], rgb[1], rgb[2], a)
    return out


def banner(bust: Image.Image, text_rgba: tuple, out: Path) -> None:
    font = bold_font(TEXT_SIZE)
    l, t, r, b = font.getbbox("engram")
    tw, th = r - l, b - t
    W = PAD + bust.width + GAP + tw + PAD
    H = max(bust.height, th) + 2 * PAD
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    im.paste(bust, (PAD, (H - bust.height) // 2), bust)
    d = ImageDraw.Draw(im)
    d.text((PAD + bust.width + GAP - l, (H - th) // 2 - t), "engram", font=font, fill=text_rgba)
    im.save(out)
    print(f"wrote {out} ({W}x{H})")


bust = keyed_bust()
banner(bust, INK, REPO / "docs/banner-light.png")
banner(recolor(bust, BUST_DARK), LIGHT, REPO / "docs/banner-dark.png")
