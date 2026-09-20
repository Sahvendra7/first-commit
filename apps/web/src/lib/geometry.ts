/**
 * Normalised geometry for the compare slider and the change marker.
 *
 * ── A note on the contract ──────────────────────────────────────────────────
 * `packages/shared` carries **no bounding-box field**. `diffAdditionSchema` is
 * `{ type, surface?, location, description }`, and §7 confirms it:
 * `additions: [{type, location, description}]`. `location` is prose — "wall
 * left of the window" — because that is what has to read well inside a legal
 * document.
 *
 * The contract is frozen (CLAUDE.md), so the box is **not** smuggled into
 * `location` and no field is added to the shared package. A drawn box is
 * client-side presentation: it positions the overlay on screen and nothing
 * more. What crosses the wire is the prose the tenant typed. If box geometry
 * should ever reach a PDF, that is a contract change to be written down and
 * agreed first — not a field invented here.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Everything below is in **normalised image space**: 0–1 on both axes,
 * relative to the rendered image box. Normalised because the same box has to
 * survive a phone rotating, a `object-fit: contain` letterbox, and a before /
 * after pair whose aspect ratios do not match.
 */

/** A point in normalised image space. */
export interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}

/** An axis-aligned box in normalised image space. `w`/`h` are always ≥ 0. */
export interface NormalizedBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Clamps to the 0–1 normalised range. NaN collapses to 0. */
export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Converts a viewport coordinate to normalised image space within `rect`.
 * A zero-sized rect (element not laid out yet, which is the normal state in
 * jsdom and briefly true on first paint) yields 0 rather than Infinity.
 */
export function pointFromClient(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): NormalizedPoint {
  return {
    x: rect.width > 0 ? clamp01((clientX - rect.left) / rect.width) : 0,
    y: rect.height > 0 ? clamp01((clientY - rect.top) / rect.height) : 0,
  };
}

/**
 * Builds a box from the two corners of a drag, in either direction — dragging
 * up-and-left is as valid as down-and-right, and a tenant marking a ceiling
 * stain will do exactly that.
 */
export function boxFromPoints(a: NormalizedPoint, b: NormalizedPoint): NormalizedBox {
  const x1 = clamp01(a.x);
  const y1 = clamp01(a.y);
  const x2 = clamp01(b.x);
  const y2 = clamp01(b.y);
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

/** Clamps a box so it cannot extend past the edges of the image. */
export function clampBox(box: NormalizedBox): NormalizedBox {
  const x = clamp01(box.x);
  const y = clamp01(box.y);
  const w = Math.max(0, Math.min(clamp01(box.w), 1 - x));
  const h = Math.max(0, Math.min(clamp01(box.h), 1 - y));
  return { x, y, w, h };
}

/**
 * A box too small to have been meant. A stray tap while scrolling a room
 * checklist produces a 0×0 box; treating that as a marked change would put
 * noise into the evidence record.
 */
export function isDegenerateBox(box: NormalizedBox, minEdge = 0.02): boolean {
  return box.w < minEdge || box.h < minEdge;
}

/** CSS percentage offsets for absolutely positioning an overlay box. */
export function boxToPercentStyle(box: NormalizedBox): {
  left: string;
  top: string;
  width: string;
  height: string;
} {
  const c = clampBox(box);
  return {
    left: `${(c.x * 100).toFixed(4)}%`,
    top: `${(c.y * 100).toFixed(4)}%`,
    width: `${(c.w * 100).toFixed(4)}%`,
    height: `${(c.h * 100).toFixed(4)}%`,
  };
}

/**
 * Describes a normalised box in the nine-cell prose the contract's `location`
 * field actually wants. This is a **suggestion seeded into an editable field**,
 * not a generated fact: the tenant can overwrite every word of it before it
 * reaches the API, and `ChangeMarker` requires a non-empty description
 * regardless.
 */
export function describeBoxPosition(box: NormalizedBox): string {
  const c = clampBox(box);
  const cx = c.x + c.w / 2;
  const cy = c.y + c.h / 2;
  const vertical = cy < 1 / 3 ? 'upper' : cy < 2 / 3 ? 'middle' : 'lower';
  const horizontal = cx < 1 / 3 ? 'left' : cx < 2 / 3 ? 'centre' : 'right';
  return `${vertical} ${horizontal} of the frame`;
}

/* ── Aspect-ratio reconciliation ────────────────────────────────────────────
 *
 * A move-in photo and a move-out photo of the same room are routinely not the
 * same shape: a different phone, a rotation, a crop. Both are rendered
 * letterboxed (`object-fit: contain`) inside one shared comparison frame, so
 * neither is distorted and the slider divides a single rectangle.
 *
 * That means a box normalised against the *image* is not the same box
 * normalised against the *frame*. These two functions are the bridge, and they
 * are pure so the mapping can be tested without laying anything out.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Where an image of aspect `imageAspect` (w / h) actually lands inside a frame
 * of aspect `frameAspect`, in normalised frame coordinates, under
 * `object-fit: contain`.
 *
 * A non-finite or non-positive aspect (an image that has not loaded yet, which
 * is the normal first-paint state) falls back to filling the frame, so the
 * overlay never jumps to NaN while a photo is in flight.
 */
export function containRect(imageAspect: number, frameAspect: number): NormalizedBox {
  if (
    !Number.isFinite(imageAspect) ||
    !Number.isFinite(frameAspect) ||
    imageAspect <= 0 ||
    frameAspect <= 0
  ) {
    return { x: 0, y: 0, w: 1, h: 1 };
  }
  if (imageAspect > frameAspect) {
    // Wider than the frame: pinned to the full width, letterboxed top and bottom.
    const h = frameAspect / imageAspect;
    return { x: 0, y: (1 - h) / 2, w: 1, h };
  }
  // Taller than (or equal to) the frame: full height, pillarboxed left and right.
  const w = imageAspect / frameAspect;
  return { x: (1 - w) / 2, y: 0, w, h: 1 };
}

/** Maps a box in normalised *image* space into normalised *frame* space. */
export function projectBoxToFrame(
  box: NormalizedBox,
  content: NormalizedBox,
): NormalizedBox {
  const b = clampBox(box);
  return {
    x: content.x + b.x * content.w,
    y: content.y + b.y * content.h,
    w: b.w * content.w,
    h: b.h * content.h,
  };
}

/**
 * The inverse: a point the tenant touched on the frame, expressed in the
 * image's own coordinates. Used by the change marker, which must record a box
 * against the photograph rather than against whatever frame it was shown in.
 *
 * A touch on the letterbox bars maps outside 0–1 and is clamped to the image
 * edge, so a drag that starts on the bar still produces a usable box.
 */
export function unprojectPointFromFrame(
  point: NormalizedPoint,
  content: NormalizedBox,
): NormalizedPoint {
  return {
    x: content.w > 0 ? clamp01((point.x - content.x) / content.w) : 0,
    y: content.h > 0 ? clamp01((point.y - content.y) / content.h) : 0,
  };
}
