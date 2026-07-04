#!/usr/bin/env python3
"""Generate engram app icons with zero deps (pure-python PNG writer).

Outputs into ./icons:
  icon-source.png  1024x1024 colored app-icon source (feed to `tauri icon`)
  tray-idle.png    44x44 monochrome template (donut) — no synthesis running
  tray-active.png  44x44 monochrome template (filled) — synthesis running
"""
import struct, zlib, math, os

OUT = os.path.join(os.path.dirname(__file__), "src-tauri", "icons")
os.makedirs(OUT, exist_ok=True)


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


def rounded_rect_alpha(x, y, w, h, r, cx, cy):
    """1.0 inside a rounded rect centered (cx,cy) size (w,h) radius r, else 0."""
    dx = abs(x - cx)
    dy = abs(y - cy)
    hw, hh = w / 2, h / 2
    if dx > hw or dy > hh:
        return 0.0
    # corner region
    ix = dx - (hw - r)
    iy = dy - (hh - r)
    if ix > 0 and iy > 0:
        d = math.hypot(ix, iy)
        return max(0.0, min(1.0, r - d + 0.5))
    return 1.0


def gen_source():
    W = 1024
    px = bytearray(W * W * 4)
    cx = cy = W / 2
    # dark rounded-square plate with a teal->indigo vertical wash + a knockout ring.
    for y in range(W):
        t = y / W
        # background gradient colors
        r0, g0, b0 = 24, 32, 40
        r1, g1, b1 = 18, 22, 30
        bg = (int(r0 + (r1 - r0) * t), int(g0 + (g1 - g0) * t), int(b0 + (b1 - b0) * t))
        # accent ring color
        ar, ag, ab = 90, 200, 190
        for x in range(W):
            a = rounded_rect_alpha(x, y, 880, 880, 200, cx, cy)
            if a <= 0:
                continue
            # ring: distance from center, band between R_in and R_out
            d = math.hypot(x - cx, y - cy)
            ring = 1.0 if 250 <= d <= 340 else 0.0
            dot = 1.0 if d <= 120 else 0.0
            i = (y * W + x) * 4
            if ring or dot:
                px[i] = ar; px[i + 1] = ag; px[i + 2] = ab
            else:
                px[i] = bg[0]; px[i + 1] = bg[1]; px[i + 2] = bg[2]
            px[i + 3] = int(255 * a)
    write_png(os.path.join(OUT, "icon-source.png"), W, W, px)


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
