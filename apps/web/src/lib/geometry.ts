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
