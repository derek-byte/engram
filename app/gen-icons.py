#!/usr/bin/env python3
"""Generate engram app icons.

Outputs into ./icons:
  icon-source.png  1024x1024 app-icon source (feed to `tauri icon`) — the ✳ mark
                   (accent green #4f6b3c) on a #f7f6f3 macOS-style rounded tile.
  tray-idle.png    44x44 monochrome template (donut) — no synthesis running
  tray-active.png  44x44 monochrome template (filled) — synthesis running

The app-icon source is an SVG rasterized with macOS `qlmanage` (this is a macOS
menu-bar app; no extra deps). The ✳ is drawn as geometry (eight round-capped
spokes) rather than a font glyph so it stays crisp and legible down to 32px and
depends on no installed font. The tray icons stay pure-python (template images:
black + alpha), keeping the ring/disc idle/active distinction legible at 44px.
"""
import struct, zlib, math, os, subprocess, tempfile

OUT = os.path.join(os.path.dirname(__file__), "src-tauri", "icons")
os.makedirs(OUT, exist_ok=True)

# ✳ mark on a rounded #f7f6f3 tile. Tile occupies ~80% of the 1024 canvas
# (macOS icon inset); corner radius ~22% of the tile; spokes fill ~56%.
SOURCE_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="102" y="102" width="820" height="820" rx="180" ry="180" fill="#f7f6f3" stroke="#e7e4de" stroke-width="4"/>
  <g stroke="#4f6b3c" stroke-width="54" stroke-linecap="round" transform="translate(512 512)">
    <line x1="0" y1="-235" x2="0" y2="235"/>
    <line x1="-235" y1="0" x2="235" y2="0"/>
    <line x1="-166" y1="-166" x2="166" y2="166"/>
    <line x1="-166" y1="166" x2="166" y2="-166"/>
  </g>
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
    """Rasterize the ✳ tile SVG to icons/icon-source.png at 1024 via qlmanage."""
    with tempfile.TemporaryDirectory() as tmp:
        svg = os.path.join(tmp, "icon-source.svg")
        with open(svg, "w") as f:
            f.write(SOURCE_SVG)
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
