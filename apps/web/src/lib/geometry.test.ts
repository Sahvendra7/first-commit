import { describe, expect, it } from 'vitest';
import {
  boxFromPoints,
  boxToPercentStyle,
  clamp01,
  clampBox,
  containRect,
  describeBoxPosition,
  isDegenerateBox,
  pointFromClient,
  projectBoxToFrame,
  unprojectPointFromFrame,
} from './geometry.js';

describe('clamp01', () => {
  it('passes through values already in range', () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1)).toBe(1);
  });

  it('clamps out-of-range values to the edges', () => {
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(42)).toBe(1);
  });

  it('collapses NaN to 0 rather than propagating it into a style string', () => {
    expect(clamp01(Number.NaN)).toBe(0);
  });
});

describe('pointFromClient', () => {
  const rect = { left: 100, top: 50, width: 200, height: 400 };

  it('maps a viewport coordinate into normalised image space', () => {
    expect(pointFromClient(200, 250, rect)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('clamps a coordinate dragged outside the element', () => {
    expect(pointFromClient(-999, 9999, rect)).toEqual({ x: 0, y: 1 });
  });

  it('returns 0 instead of Infinity when the element has not been laid out', () => {
    const p = pointFromClient(10, 10, { left: 0, top: 0, width: 0, height: 0 });
    expect(p).toEqual({ x: 0, y: 0 });
    expect(Number.isFinite(p.x)).toBe(true);
  });
});

describe('boxFromPoints', () => {
  it('builds a box from a down-and-right drag', () => {
    expect(boxFromPoints({ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.8 })).toEqual({
      x: 0.1,
      y: 0.2,
      w: 0.4,
      h: 0.6000000000000001,
    });
  });

  it('normalises an up-and-left drag to the same box', () => {
    const downRight = boxFromPoints({ x: 0.2, y: 0.2 }, { x: 0.6, y: 0.7 });
    const upLeft = boxFromPoints({ x: 0.6, y: 0.7 }, { x: 0.2, y: 0.2 });
    expect(upLeft).toEqual(downRight);
  });

  it('never produces a negative width or height', () => {
    const box = boxFromPoints({ x: 0.9, y: 0.9 }, { x: 0.1, y: 0.1 });
    expect(box.w).toBeGreaterThanOrEqual(0);
    expect(box.h).toBeGreaterThanOrEqual(0);
  });

  it('clamps corners dragged past the edge of the image', () => {
    expect(boxFromPoints({ x: -1, y: -1 }, { x: 2, y: 2 })).toEqual({
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    });
  });
});

describe('clampBox', () => {
  it('leaves a box fully inside the image untouched', () => {
    const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.3 };
    expect(clampBox(box)).toEqual(box);
  });

  it('trims a box that would overflow the right and bottom edges', () => {
    expect(clampBox({ x: 0.8, y: 0.9, w: 0.5, h: 0.5 })).toEqual({
      x: 0.8,
      y: 0.9,
      w: 0.19999999999999996,
      h: 0.09999999999999998,
    });
  });

  it('clamps a negative origin without inventing size', () => {
    expect(clampBox({ x: -0.5, y: -0.5, w: 0.2, h: 0.2 })).toEqual({
      x: 0,
      y: 0,
      w: 0.2,
      h: 0.2,
    });
  });
});

describe('isDegenerateBox', () => {
  it('rejects the 0x0 box a stray tap produces', () => {
    expect(isDegenerateBox({ x: 0.5, y: 0.5, w: 0, h: 0 })).toBe(true);
  });

  it('rejects a box that is thin on only one axis', () => {
    expect(isDegenerateBox({ x: 0, y: 0, w: 0.9, h: 0.001 })).toBe(true);
  });

  it('accepts a deliberately drawn box', () => {
    expect(isDegenerateBox({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 })).toBe(false);
  });

  it('honours a caller-supplied minimum edge', () => {
    const box = { x: 0, y: 0, w: 0.05, h: 0.05 };
    expect(isDegenerateBox(box, 0.02)).toBe(false);
    expect(isDegenerateBox(box, 0.1)).toBe(true);
  });
});

describe('boxToPercentStyle', () => {
  it('emits CSS percentages for an absolutely positioned overlay', () => {
    expect(boxToPercentStyle({ x: 0.25, y: 0.5, w: 0.1, h: 0.2 })).toEqual({
      left: '25.0000%',
      top: '50.0000%',
      width: '10.0000%',
      height: '20.0000%',
    });
  });

  it('clamps before formatting, so no overlay escapes the image', () => {
    const style = boxToPercentStyle({ x: 0.9, y: 0, w: 5, h: 1 });
    expect(style.left).toBe('90.0000%');
    expect(style.width).toBe('10.0000%');
  });
});

describe('describeBoxPosition', () => {
  it('describes the nine cells in the prose the contract location field wants', () => {
    expect(describeBoxPosition({ x: 0, y: 0, w: 0.1, h: 0.1 })).toBe(
      'upper left of the frame',
    );
    expect(describeBoxPosition({ x: 0.45, y: 0.45, w: 0.1, h: 0.1 })).toBe(
      'middle centre of the frame',
    );
    expect(describeBoxPosition({ x: 0.85, y: 0.85, w: 0.1, h: 0.1 })).toBe(
      'lower right of the frame',
    );
  });

  it('uses the centre of the box, not its origin', () => {
    // Origin sits in the upper-left cell; the centre does not.
    expect(describeBoxPosition({ x: 0.3, y: 0.3, w: 0.4, h: 0.4 })).toBe(
      'middle centre of the frame',
    );
  });
});

describe('containRect', () => {
  it('fills the frame when the aspects match', () => {
    expect(containRect(4 / 3, 4 / 3)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('letterboxes a wide photo inside a squarer frame', () => {
    // 16:9 inside 4:3 — full width, bars top and bottom.
    const rect = containRect(16 / 9, 4 / 3);
    expect(rect.w).toBe(1);
    expect(rect.h).toBeCloseTo(0.75, 6);
    expect(rect.x).toBe(0);
    expect(rect.y).toBeCloseTo(0.125, 6);
  });

  it('pillarboxes a tall photo inside a wider frame', () => {
    // 3:4 portrait inside 4:3 landscape — full height, bars left and right.
    const rect = containRect(3 / 4, 4 / 3);
    expect(rect.h).toBe(1);
    expect(rect.w).toBeCloseTo(0.5625, 6);
    expect(rect.y).toBe(0);
    expect(rect.x).toBeCloseTo(0.21875, 6);
  });

  it('always centres the letterbox', () => {
    const rect = containRect(16 / 9, 1);
    expect(rect.y).toBeCloseTo((1 - rect.h) / 2, 12);
  });

  it('falls back to filling the frame while an image has no dimensions yet', () => {
    expect(containRect(0, 4 / 3)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(containRect(Number.NaN, 4 / 3)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(containRect(4 / 3, 0)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe('projectBoxToFrame', () => {
  it('is the identity when the image fills the frame', () => {
    const box = { x: 0.2, y: 0.3, w: 0.4, h: 0.1 };
    expect(projectBoxToFrame(box, { x: 0, y: 0, w: 1, h: 1 })).toEqual(box);
  });

  it('shifts and shrinks a box into a letterboxed content rect', () => {
    const content = containRect(16 / 9, 4 / 3); // y 0.125, h 0.75
    const projected = projectBoxToFrame({ x: 0, y: 0, w: 1, h: 1 }, content);
    expect(projected.x).toBe(0);
    expect(projected.y).toBeCloseTo(0.125, 6);
    expect(projected.w).toBe(1);
    expect(projected.h).toBeCloseTo(0.75, 6);
  });

  it('keeps a centred box centred', () => {
    const content = containRect(3 / 4, 4 / 3);
    const projected = projectBoxToFrame({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, content);
    expect(projected.x + projected.w / 2).toBeCloseTo(0.5, 6);
    expect(projected.y + projected.h / 2).toBeCloseTo(0.5, 6);
  });
});

describe('unprojectPointFromFrame', () => {
  it('round-trips with projectBoxToFrame', () => {
    const content = containRect(16 / 9, 4 / 3);
    const box = { x: 0.25, y: 0.5, w: 0.2, h: 0.2 };
    const framed = projectBoxToFrame(box, content);
    const origin = unprojectPointFromFrame({ x: framed.x, y: framed.y }, content);
    expect(origin.x).toBeCloseTo(box.x, 6);
    expect(origin.y).toBeCloseTo(box.y, 6);
  });

  it('clamps a touch on the letterbox bar to the edge of the image', () => {
    const content = containRect(16 / 9, 4 / 3); // bars above y=0.125
    expect(unprojectPointFromFrame({ x: 0.5, y: 0 }, content).y).toBe(0);
    expect(unprojectPointFromFrame({ x: 0.5, y: 1 }, content).y).toBe(1);
  });

  it('returns 0 rather than Infinity for a zero-sized content rect', () => {
    const p = unprojectPointFromFrame({ x: 0.5, y: 0.5 }, { x: 0, y: 0, w: 0, h: 0 });
    expect(p).toEqual({ x: 0, y: 0 });
  });
});
