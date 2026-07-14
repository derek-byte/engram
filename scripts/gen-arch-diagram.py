#!/usr/bin/env python3
"""Excalidraw-style architecture diagram for the engram README.
Hand-wobble SVG -> PNG via qlmanage (same rasterizer as app/scripts/gen-icons.py)."""
import math
import random
import subprocess
import sys
import tempfile
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "architecture.png")

W, H = 2280, 660
INK = "#1e1e1e"
FAINT = "#6b6b6b"
FONT = "Chalkboard SE, Chalkboard, Comic Sans MS, cursive"
rng = random.Random(11)


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


def stroke(d, width=2.6, opacity=0.92, color=INK, dash=""):
    dd = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}" '
            f'stroke-linecap="round" opacity="{opacity}"{dd}/>')


def rect(x, y, bw, bh, passes=2, width=2.6, color=INK, dash=""):
    parts = []
    for _ in range(passes):
        parts.append(stroke(wobble_line(x + 4, y, x + bw - 4, y), width, color=color, dash=dash))
        parts.append(stroke(wobble_line(x + bw, y + 4, x + bw, y + bh - 4), width, color=color, dash=dash))
        parts.append(stroke(wobble_line(x + bw - 4, y + bh, x + 4, y + bh), width, color=color, dash=dash))
        parts.append(stroke(wobble_line(x, y + bh - 4, x, y + 4), width, color=color, dash=dash))
    return "".join(parts)


def arrow(x1, y1, x2, y2, curve=0.0):
    parts = []
    if abs(curve) > 0:
        mx, my = (x1 + x2) / 2, (y1 + y2) / 2 + curve
        parts.append(stroke(f"M{w(x1,1):.1f},{w(y1,1):.1f} Q{mx:.1f},{my:.1f} {w(x2,1):.1f},{w(y2,1):.1f}", 2.4))
        ang = math.atan2(y2 - my, x2 - mx)
    else:
        parts.append(stroke(wobble_line(x1, y1, x2, y2, 1.6), 2.4))
        ang = math.atan2(y2 - y1, x2 - x1)
    for da in (math.radians(152), math.radians(-152)):
        parts.append(stroke(wobble_line(x2, y2, x2 + 16 * math.cos(ang + da), y2 + 16 * math.sin(ang + da), 0.8), 2.4))
    return "".join(parts)


def text(cx, cy, lines, title=True, tsize=25, ssize=20, lh=28, color=INK, anchor="middle"):
    parts = []
    n = len(lines)
    for i, line in enumerate(lines):
        size = tsize if (title and i == 0) else ssize
        weight = "bold" if (title and i == 0) else "normal"
        dy = cy + (i - (n - 1) / 2) * lh
        parts.append(f'<text x="{cx}" y="{dy}" font-family="{FONT}" font-size="{size}" '
                     f'font-weight="{weight}" fill="{color}" text-anchor="{anchor}" '
                     f'dominant-baseline="middle">{line}</text>')
    return "".join(parts)


CY = 380
BH = 120
svg_parts = []


def box(x, bw, title, subs, cy=CY, bh=BH, tsize=25, ssize=19):
    svg_parts.append(rect(x, cy - bh / 2, bw, bh))
    svg_parts.append(text(x + bw / 2, cy, [title] + subs, tsize=tsize, ssize=ssize, lh=27))
    return x, x + bw


# main row
box(24, 250, "~/.claude/projects", ["session jsonl logs"])
box(316, 240, "ingest/", ["parse &#183; chunk &#183;", "caption &#183; embed"])
box(598, 250, "storage/", ["raw_events + chunks", "(L0 &#183; tier=raw)"])

# synthesis container
SC_X, SC_W = 894, 660
svg_parts.append(rect(SC_X, 284, SC_W, 232, passes=1, width=2.0, dash="1 7"))
svg_parts.append(text(SC_X + 18, 496, ["synthesis &#183; nightly + post-ingest queue"], title=False,
                      ssize=19, color=FAINT, anchor="start"))
box(922, 280, "dream/", ["LLM synthesis", "(L1 &#183; tier=dream)"])
box(1246, 280, "wiki/", ["pages &#8594; index.md", "(L2&#8594;L3 &#183; tier=wiki)"])

box(1580, 240, "search/", ["hybrid + recency", "+ rerank"])

# surfaces container with 2x2 mini boxes
SF_X, SF_W = 1856, 400
svg_parts.append(rect(SF_X, 284, SF_W, 232, passes=1, width=2.0, dash="1 7"))
svg_parts.append(text(SF_X + 18, 496, ["surfaces"], title=False, ssize=19, color=FAINT, anchor="start"))
minis = [("ask", 1884, 298), ("context", 2068, 298), ("MCP", 1884, 388), ("UI &#183; app", 2068, 388)]
for label, mx, my in minis:
    svg_parts.append(rect(mx, my, 160, 74))
    svg_parts.append(text(mx + 80, my + 37, [label], tsize=21))

# flow arrows
for x1, x2 in ((274, 312), (556, 594), (848, 918), (1202, 1242), (1526, 1576), (1820, 1852)):
    svg_parts.append(arrow(x1, CY, x2, CY))

# storage -> search skip edge over the synthesis container
svg_parts.append(arrow(753, CY - BH / 2 - 2, 1700, CY - BH / 2 - 4, curve=-175))

PAD_TOP = (W - H) / 2
svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{W}" viewBox="0 0 {W} {W}">',
       f'<rect width="{W}" height="{W}" fill="white"/>',
       f'<g transform="translate(0,{PAD_TOP - 41})">'] + svg_parts + ["</g></svg>"]

with tempfile.TemporaryDirectory() as td:
    src = Path(td) / "arch.svg"
    src.write_text("".join(svg))
    subprocess.run(["qlmanage", "-t", "-s", str(W), "-o", td, str(src)], check=True, capture_output=True)
    OUT.write_bytes((Path(td) / "arch.svg.png").read_bytes())
subprocess.run(["sips", "--cropToHeightWidth", str(H), str(W), str(OUT)], check=True, capture_output=True)
print(f"wrote {OUT}")
