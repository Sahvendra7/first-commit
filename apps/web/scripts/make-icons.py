#!/usr/bin/env python3
"""
Generates the PWA icon set.

Written as a committed generator rather than as committed binaries with no
provenance: the mark is procedural, so a change to it is a readable diff and
every size is guaranteed to be the same artwork rather than four files that
drifted apart.

Pure standard library on purpose. The build host has no Pillow and no
rsvg-convert, and adding an image toolchain to a frontend that needs four PNGs
once is exactly the "unnecessary complexity" the brief rules out. PNG is a
container around zlib-compressed scanlines, which `zlib` and `struct` already
cover.

The mark is the one in `src/ui/Logo.tsx`, on the same 32-unit grid: two offset
frames — the view as it was, and the same view later — with a seal where the
two are held against each other. The web mark draws the back frame dashed; this
one draws it in a lighter tone instead, because a 2.5-unit dash is under a pixel
once a launcher has scaled the icon to 48px and the frame simply disappears.

    python3 scripts/make-icons.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

# Rendered at this multiple and box-filtered down, which is how the rounded
# corners and the divider get clean edges without an AA implementation.
SUPERSAMPLE = 4

# The palette, from `src/index.css`. Kept as literals rather than parsed out of
# the CSS: four numbers that change once a year do not justify a parser, and a
# wrong colour here is visible in the diff.
BRAND = (14, 59, 60)
WHITE = (255, 255, 255)
BRAND_LINE = (190, 214, 211)
ACCENT = (178, 96, 58)

OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "icons"

# The mark's geometry, in the 32-unit grid `Logo.tsx` uses, as fractions of the
# canvas. Changing the SVG and not these is the drift this comment exists to
# prevent — the two are checked against each other by eye, once, here.
G = 32.0
BACK_FRAME = (6.75 / G, 8.75 / G, 20.25 / G, 20.25 / G)
FRONT_FRAME = (11.75 / G, 12.75 / G, 25.25 / G, 24.25 / G)
SEAL = (18.5 / G, 18.5 / G, 2.75 / G)
FRAME_RADIUS = 2.0 / G
STROKE = 1.5 / G


def in_rounded_rect(x: float, y: float, x0: float, y0: float, x1: float, y1: float, r: float) -> bool:
    """True when (x, y) lies inside a rounded rectangle."""
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    r = min(r, (x1 - x0) / 2, (y1 - y0) / 2)
    if r <= 0:
        return True
    # Clamp the point to the inner rectangle whose corners are the arc centres;
    # the distance to that clamped point is the distance to the shape's edge.
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def on_frame(x: float, y: float, rect: tuple[float, float, float, float], stroke: float) -> bool:
    """True on the stroked outline of a rounded rectangle, centred on the path."""
    x0, y0, x1, y1 = rect
    half = stroke / 2
    outer = in_rounded_rect(x, y, x0 - half, y0 - half, x1 + half, y1 + half, FRAME_RADIUS + half)
    inner = in_rounded_rect(x, y, x0 + half, y0 + half, x1 - half, y1 - half, max(0.0, FRAME_RADIUS - half))
    return outer and not inner


def render(size: int, safe_zone: float) -> bytes:
    """
    Draws the mark at `size` and returns raw RGB bytes.

    `safe_zone` is the fraction of the canvas the artwork is inset by. A
    maskable icon is cropped to a circle by the launcher, so its artwork sits
    inside the inner 80% or it loses its corners.
    """
    s = size * SUPERSAMPLE
    plate_r = 0.22

    # The artwork is defined in unit space; the safe zone scales it about the
    # centre, so one geometry definition serves both the full-bleed and the
    # maskable icon.
    scale = 1.0 - 2 * safe_zone

    def to_unit(px: float) -> float:
        return px / s

    def artwork(u: float, v: float) -> tuple[float, float]:
        return (u - 0.5) / scale + 0.5, (v - 0.5) / scale + 0.5

    rows: list[list[tuple[int, int, int]]] = []
    for py in range(s):
        row: list[tuple[int, int, int]] = []
        v = to_unit(py + 0.5)
        for px in range(s):
            u = to_unit(px + 0.5)
            colour = BRAND
            if not in_rounded_rect(u, v, 0.0, 0.0, 1.0, 1.0, plate_r):
                # Outside the plate. This encoder has no alpha channel, so the
                # corner takes the plate colour; every launcher masks it anyway.
                colour = BRAND
            else:
                ax, ay = artwork(u, v)
                sx, sy, sr = SEAL
                if (ax - sx) ** 2 + (ay - sy) ** 2 <= sr * sr:
                    colour = ACCENT
                elif on_frame(ax, ay, FRONT_FRAME, STROKE):
                    colour = WHITE
                elif on_frame(ax, ay, BACK_FRAME, STROKE):
                    colour = BRAND_LINE
            row.append(colour)
        rows.append(row)

    # Box filter down to the requested size.
    counts = SUPERSAMPLE * SUPERSAMPLE
    raw = bytearray()
    for oy in range(size):
        raw.append(0)  # filter type 0 (None) for this scanline
        for ox in range(size):
            r = g = b = 0
            for dy in range(SUPERSAMPLE):
                srow = rows[oy * SUPERSAMPLE + dy]
                for dx in range(SUPERSAMPLE):
                    c = srow[ox * SUPERSAMPLE + dx]
                    r += c[0]
                    g += c[1]
                    b += c[2]
            raw.extend((r // counts, g // counts, b // counts))
    return bytes(raw)


def chunk(tag: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + tag
        + payload
        + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    )


def write_png(path: Path, size: int, raw: bytes) -> None:
    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    # `any` icons use the full canvas; the maskable one is inset so a circular
    # crop does not eat the frame.
    for name, size, safe in (
        ("icon-192.png", 192, 0.0),
        ("icon-512.png", 512, 0.0),
        ("icon-maskable-512.png", 512, 0.10),
        ("apple-touch-icon.png", 180, 0.0),
    ):
        write_png(OUT_DIR / name, size, render(size, safe))
        print(f"wrote {name} ({size}x{size})")


if __name__ == "__main__":
    main()
