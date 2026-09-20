import { describe, expect, it } from 'vitest';
import { ENCODE_QUALITY, MAX_EDGE_PX, fitWithin } from './image-resize.js';

describe('§5.1 encode constants', () => {
  it('matches the spec: long edge ~1600px at quality 0.8', () => {
    expect(MAX_EDGE_PX).toBe(1600);
    expect(ENCODE_QUALITY).toBe(0.8);
  });
});

describe('fitWithin', () => {
  it('scales a landscape photo by its long edge', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 1600, height: 1200 });
  });

  it('scales a portrait photo by its long edge', () => {
    expect(fitWithin(3024, 4032)).toEqual({ width: 1200, height: 1600 });
  });

  it('leaves an image already within budget alone rather than upscaling it', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('treats an image exactly at the limit as within budget', () => {
    expect(fitWithin(1600, 900)).toEqual({ width: 1600, height: 900 });
  });

  it('preserves aspect ratio to within a pixel', () => {
    const { width, height } = fitWithin(4000, 2251);
    expect(width).toBe(1600);
    expect(Math.abs(width / height - 4000 / 2251)).toBeLessThan(0.001);
  });

  it('never returns a zero edge for an extreme panorama', () => {
    const { width, height } = fitWithin(16000, 3);
    expect(width).toBe(1600);
    expect(height).toBe(1);
  });

  it('rounds to whole pixels', () => {
    const { width, height } = fitWithin(3333, 2222);
    expect(Number.isInteger(width)).toBe(true);
    expect(Number.isInteger(height)).toBe(true);
  });

  it('honours a caller-supplied max edge', () => {
    expect(fitWithin(4000, 2000, 400)).toEqual({ width: 400, height: 200 });
  });

  it('rejects a degenerate source rather than producing an unusable canvas', () => {
    expect(() => fitWithin(0, 100)).toThrow(/cannot resize/);
    expect(() => fitWithin(100, -1)).toThrow(/cannot resize/);
    expect(() => fitWithin(Number.NaN, 100)).toThrow(/cannot resize/);
  });
});
