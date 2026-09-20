import { describe, expect, it } from 'vitest';
import { CHANGE_SURFACES, CHANGE_TYPES, diffAdditionSchema } from '@handover/shared';
import { toDiffAddition, toDiffAdditions, validateMark } from './marked-change.js';
import type { MarkedChange } from './marked-change.js';

const MARK: MarkedChange = {
  id: 'local-1',
  type: 'STAIN',
  surface: 'WALL',
  location: 'wall left of the window',
  description: 'Dark patch about 20cm across, not present at move-in.',
  box: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 },
};

describe('toDiffAddition', () => {
  it('produces something the frozen schema accepts', () => {
    expect(() => diffAdditionSchema.parse(toDiffAddition(MARK))).not.toThrow();
  });

  it('drops the box — the contract has no geometry field', () => {
    const addition = toDiffAddition(MARK);
    expect(addition).not.toHaveProperty('box');
    expect(Object.keys(addition).sort()).toEqual([
      'description',
      'location',
      'surface',
      'type',
    ]);
  });

  it('drops the client-local id too — the server assigns the real one', () => {
    expect(toDiffAddition(MARK)).not.toHaveProperty('id');
  });

  it('omits surface entirely when none was chosen', () => {
    const { surface: _surface, ...withoutSurface } = MARK;
    expect(toDiffAddition(withoutSurface)).not.toHaveProperty('surface');
  });

  it('carries a mark that was never drawn, because a box was never required', () => {
    const { box: _box, ...undrawn } = MARK;
    expect(() => toDiffAddition(undrawn)).not.toThrow();
  });

  it('synthesises no confidence — a human assertion is not a sampled one', () => {
    expect(toDiffAddition(MARK)).not.toHaveProperty('confidence');
  });

  it('trims through the schema', () => {
    const addition = toDiffAddition({ ...MARK, location: '  by the door  ' });
    expect(addition.location).toBe('by the door');
  });

  it('rejects an empty description rather than sending one', () => {
    expect(() => toDiffAddition({ ...MARK, description: '' })).toThrow();
  });

  it('rejects a description past the contract bound', () => {
    expect(() => toDiffAddition({ ...MARK, description: 'x'.repeat(601) })).toThrow();
  });

  it('maps a whole list', () => {
    expect(toDiffAdditions([MARK, { ...MARK, id: 'local-2' }])).toHaveLength(2);
  });

  it('accepts every type and surface the contract defines', () => {
    for (const type of CHANGE_TYPES) {
      for (const surface of CHANGE_SURFACES) {
        expect(() => toDiffAddition({ ...MARK, type, surface })).not.toThrow();
      }
    }
  });
});

describe('validateMark', () => {
  it('passes a complete draft', () => {
    expect(validateMark({ location: 'by the door', description: 'Scuffed.' })).toEqual({});
  });

  it('requires a location', () => {
    expect(validateMark({ location: '   ', description: 'Scuffed.' }).location).toBeDefined();
  });

  it('requires a description', () => {
    expect(validateMark({ location: 'by the door', description: '' }).description).toBeDefined();
  });

  it('mirrors the contract bounds rather than inventing its own', () => {
    expect(
      validateMark({ location: 'x'.repeat(200), description: 'y'.repeat(600) }),
    ).toEqual({});
    expect(validateMark({ location: 'x'.repeat(201), description: 'ok' }).location).toBeDefined();
    expect(
      validateMark({ location: 'ok', description: 'y'.repeat(601) }).description,
    ).toBeDefined();
  });
});
