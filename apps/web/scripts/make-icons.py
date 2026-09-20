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

The mark is a before/after frame: one rounded rectangle split down the middle,
the right half tinted. That is the product — two photographs of the same view,
side by side — and it stays legible at 48px.

    python3 scripts/make-icons.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

# Rendered at this multiple and box-filtered down, which is how the rounded
# corners and the divider get clean edges without an AA implementation.
SUPERSAMPLE = 4

SLATE_900 = (15, 23, 42)
WHITE = (255, 255, 255)
SKY_300 = (125, 211, 252)

OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "icons"


def rounded_rect_contains(x: float, y: float, x0: float, y0: float, x1: float, y1: float, r: float) -> bool:
    """True when (x, y) is inside a rounded rectangle."""
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    for cx, cy in ((x0 + r, y0 + r), (x1 - r, y0 + r), (x0 + r, y1 - r), (x1 - r, y1 - r)):
        # Only the corner quadrants need the radius test.
        if (x < x0 + r or x > x1 - r) and (y < y0 + r or y > y1 - r):
            if (x - cx) ** 2 + (y - cy) ** 2 > r * r:
                # Keep checking the other corners; a point outside this corner's
                # circle may still be inside another quadrant's.
                continue
            return True
    if (x < x0 + r or x > x1 - r) and (y < y0 + r or y > y1 - r):
        return False
    return True


def render(size: int, safe_zone: float) -> bytes:
    """
    Draws the mark at `size` and returns raw RGB bytes.

    `safe_zone` is the fraction of the canvas the artwork is inset by. A
    maskable icon is cropped to a circle by the launcher, so its artwork sits
    inside the inner 80% or it loses its corners.
    """
    s = size * SUPERSAMPLE
    inset = s * safe_zone

    # Plate: the full-bleed background.
    plate_r = s * 0.22

    # Frame: the before/after rectangle.
    fx0 = inset + s * 0.13
    fx1 = s - inset - s * 0.13
    fy0 = inset + s * 0.20
    fy1 = s - inset - s * 0.20
    frame_r = s * 0.045
    stroke = max(1.0, s * 0.032)
    mid = (fx0 + fx1) / 2

    accum = [[(0, 0, 0)] * size for _ in range(size)]
    counts = SUPERSAMPLE * SUPERSAMPLE

    rows: list[list[tuple[int, int, int]]] = []
    for py in range(s):
        row: list[tuple[int, int, int]] = []
        y = py + 0.5
        for px in range(s):
            x = px + 0.5
            colour = (255, 255, 255)

            if not rounded_rect_contains(x, y, 0, 0, s - 1, s - 1, plate_r):
                # Outside the plate: transparent is not supported by this
                # encoder's RGB mode, so the corner takes the plate colour's
                # background. Launchers mask it anyway.
                colour = SLATE_900
            else:
                colour = SLATE_900
                inside_frame = rounded_rect_contains(x, y, fx0, fy0, fx1, fy1, frame_r)
                inside_inner = rounded_rect_contains(
                    x, y, fx0 + stroke, fy0 + stroke, fx1 - stroke, fy1 - stroke, max(0.0, frame_r - stroke)
                )
                if inside_frame and not inside_inner:
                    colour = WHITE
                elif inside_inner:
                    # The divider, and the tinted "after" half beside it.
                    if abs(x - mid) <= stroke / 2:
                        colour = WHITE
                    elif x > mid:
                        colour = SKY_300
                    else:
                        colour = SLATE_900
            row.append(colour)
        rows.append(row)

    # Box filter down to the requested size.
    for oy in range(size):
        for ox in range(size):
            r = g = b = 0
            for dy in range(SUPERSAMPLE):
                srow = rows[oy * SUPERSAMPLE + dy]
                for dx in range(SUPERSAMPLE):
                    c = srow[ox * SUPERSAMPLE + dx]
                    r += c[0]
                    g += c[1]
                    b += c[2]
            accum[oy][ox] = (r // counts, g // counts, b // counts)

    raw = bytearray()
    for oy in range(size):
        raw.append(0)  # filter type 0 (None) for this scanline
        for ox in range(size):
            raw.extend(accum[oy][ox])
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
