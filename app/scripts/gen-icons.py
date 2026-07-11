#!/usr/bin/env python3
"""Generate macos engram app icons.

Outputs into ./icons:
  icon-source.png  1024x1024 app-icon source (feed to `tauri icon`) — the
                   halftone-bust art (icons/icon-art.png) cover-cropped onto a
                   macOS-style rounded tile.
  tray-idle.png    44x44 monochrome template (donut) — no synthesis running
  tray-active.png  44x44 monochrome template (filled) — synthesis running

The app-icon source is an SVG (art embedded as a data URI, clipped to the tile)
rasterized with macOS `qlmanage` (this is a macOS menu-bar app; no extra deps).
The tray icons stay pure-python (template images: black + alpha), keeping the
ring/disc idle/active distinction legible at 44px.
"""
import base64, struct, zlib, math, os, subprocess, tempfile

OUT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons"))
os.makedirs(OUT, exist_ok=True)

ART = os.path.join(OUT, "icon-art.png")


def source_svg():
    with open(ART, "rb") as f:
        art = base64.b64encode(f.read()).decode()
    return f"""<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <clipPath id="tile"><rect x="102" y="102" width="820" height="820" rx="180" ry="180"/></clipPath>
  </defs>
  <rect x="102" y="102" width="820" height="820" rx="180" ry="180" fill="#ffffff"/>
  <image xlink:href="data:image/png;base64,{art}" x="102" y="102" width="820" height="820"
         preserveAspectRatio="xMidYMid slice" clip-path="url(#tile)"/>
  <rect x="102" y="102" width="820" height="820" rx="180" ry="180" fill="none" stroke="#e7e4de" stroke-width="4"/>
</svg>
"""


def write_png(path, w, h, pixels):
    """pixels: flat bytearray of RGBA, len == w*h*4."""
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)  # filter type 0
        raw.extend(pixels[y * stride:(y + 1) * stride])
    comp = zlib.compress(bytes(raw), 9)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8-bit RGBA
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", comp))
        f.write(chunk(b"IEND", b""))


def gen_source():
    """Rasterize the bust-tile SVG to icons/icon-source.png at 1024 via qlmanage."""
    with tempfile.TemporaryDirectory() as tmp:
        svg = os.path.join(tmp, "icon-source.svg")
        with open(svg, "w") as f:
            f.write(source_svg())
        subprocess.run(
            ["qlmanage", "-t", "-s", "1024", svg, "-o", tmp],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        thumb = svg + ".png"  # qlmanage names it <input>.png
        os.replace(thumb, os.path.join(OUT, "icon-source.png"))


def gen_tray(name, filled):
    W = 44
    px = bytearray(W * W * 4)
    cx = cy = (W - 1) / 2
    R_out = 17
    R_in = 11
    for y in range(W):
        for x in range(W):
            d = math.hypot(x - cx, y - cy)
            a = 0.0
            # outer ring edge antialias
            if d <= R_out:
                a = min(1.0, R_out - d + 0.5)
                if not filled and d < R_in:
                    a = max(0.0, min(1.0, d - R_in + 0.5))
            i = (y * W + x) * 4
            # template image: pure black, alpha carries the shape
            px[i] = 0; px[i + 1] = 0; px[i + 2] = 0
            px[i + 3] = int(255 * max(0.0, min(1.0, a)))
    write_png(os.path.join(OUT, name), W, W, px)


gen_source()
gen_tray("tray-idle.png", filled=False)
gen_tray("tray-active.png", filled=True)
print("icons written to", OUT)
