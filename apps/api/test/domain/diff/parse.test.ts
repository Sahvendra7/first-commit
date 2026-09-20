import { describe, expect, it } from 'vitest';
import { parseModelResponse } from '../../../src/domain/diff/parse.js';

/**
 * §9.3, §9.5. There is no tool-use on the provisional endpoint, so this parser
 * is the entire output contract. The tolerances below are not hypothetical:
 * every measured run carried leading whitespace and one in four wrapped the
 * object in a ```json fence.
 */

const ONE_CHANGE = {
  changes: [
    {
      type: 'SCRATCH',
      surface: 'WALL',
      location: 'wall left of the window, waist height',
      description: 'A red mark roughly 20cm long that is not present in the first photograph.',
      confidence: 0.6,
    },
  ],
};

function bodyOf(value: unknown): string {
  return JSON.stringify(value);
}

describe('parseModelResponse — tolerances', () => {
  it('parses a clean object', () => {
    const out = parseModelResponse(bodyOf(ONE_CHANGE));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.changes).toHaveLength(1);
    expect(out.value.changes[0]?.type).toBe('SCRATCH');
    expect(out.diagnostics.hadCodeFence).toBe(false);
    expect(out.diagnostics.hadLeadingWhitespace).toBe(false);
  });

  it('survives leading and trailing whitespace, and records it', () => {
    const out = parseModelResponse(`\n\n   ${bodyOf(ONE_CHANGE)}  \n`);
    expect(out.ok).toBe(true);
    expect(out.diagnostics.hadLeadingWhitespace).toBe(true);
    expect(out.diagnostics.hadTrailingWhitespace).toBe(true);
  });

  it('survives a ```json fence, and records it', () => {
    const out = parseModelResponse('```json\n' + bodyOf(ONE_CHANGE) + '\n```');
    expect(out.ok).toBe(true);
    expect(out.diagnostics.hadCodeFence).toBe(true);
  });

  it('survives a bare ``` fence', () => {
    const out = parseModelResponse('```\n' + bodyOf(ONE_CHANGE) + '\n```');
    expect(out.ok).toBe(true);
    expect(out.diagnostics.hadCodeFence).toBe(true);
  });

  it('survives prose before and after the object, and records it', () => {
    const out = parseModelResponse(
      `Here is my analysis of the two photographs.\n\n${bodyOf(ONE_CHANGE)}\n\nLet me know if you need more detail.`,
    );
    expect(out.ok).toBe(true);
    expect(out.diagnostics.hadProseBefore).toBe(true);
    expect(out.diagnostics.hadProseAfter).toBe(true);
  });

  it('extracts the FIRST balanced object when prose contains braces afterwards', () => {
    const out = parseModelResponse(
      `${bodyOf(ONE_CHANGE)}\n\nFor reference the schema is {"changes":[]} but I ignored it.`,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.changes).toHaveLength(1);
  });

  it('handles nested objects and braces inside string values', () => {
    const nested = {
      changes: [
        {
          ...ONE_CHANGE.changes[0],
          description: 'A mark shaped like a brace {} near the skirting, absent before.',
          wearAndTear: {
            landlordMayArgue: 'this exceeds normal use',
            tenantsTypicallyCounter: 'marks of this size are ordinary over two years',
          },
        },
      ],
    };
    const out = parseModelResponse('```json\n' + bodyOf(nested) + '\n```');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.changes[0]?.wearAndTear?.landlordMayArgue).toBe('this exceeds normal use');
  });

  it('accepts an empty change list — the correct answer on a distractor pair', () => {
    const out = parseModelResponse('  {"changes":[]}');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.changes).toEqual([]);
  });

  it('normalises lower-case enum values rather than failing on them', () => {
    const out = parseModelResponse(
      bodyOf({ changes: [{ ...ONE_CHANGE.changes[0], type: 'scratch', surface: 'wall' }] }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.changes[0]?.type).toBe('SCRATCH');
    expect(out.value.changes[0]?.surface).toBe('WALL');
  });

  it('defaults a missing type to OTHER — a repair that invents nothing', () => {
    const { type: _dropped, ...noType } = ONE_CHANGE.changes[0]!;
    const out = parseModelResponse(bodyOf({ changes: [noType] }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.changes[0]?.type).toBe('OTHER');
  });
});

describe('parseModelResponse — typed failures', () => {
  it('returns NO_JSON_OBJECT for a pure prose refusal', () => {
    const out = parseModelResponse('I am unable to compare these photographs.');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('NO_JSON_OBJECT');
  });

  it('returns NO_JSON_OBJECT for an empty response', () => {
    const out = parseModelResponse('   \n  ');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('NO_JSON_OBJECT');
  });

  it('returns MALFORMED_JSON for a truncated object', () => {
    const out = parseModelResponse('{"changes":[{"type":"STAIN","surface":"WALL"');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('MALFORMED_JSON');
  });

  it('returns SCHEMA_INVALID when confidence is out of range', () => {
    const out = parseModelResponse(
      bodyOf({ changes: [{ ...ONE_CHANGE.changes[0], confidence: 4 }] }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('SCHEMA_INVALID');
    expect(out.detail).toMatch(/confidence/i);
  });

  it('returns SCHEMA_INVALID when the object is not a change list at all', () => {
    const out = parseModelResponse('{"answer": "the rooms look the same"}');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('SCHEMA_INVALID');
  });

  it('rejects an implausible change count rather than storing it', () => {
    const many = { changes: Array.from({ length: 51 }, () => ONE_CHANGE.changes[0]) };
    const out = parseModelResponse(bodyOf(many));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('SCHEMA_INVALID');
  });

  it('reports diagnostics even on failure, so the eval can count fences', () => {
    const out = parseModelResponse('```json\n{"nope": true}\n```');
    expect(out.ok).toBe(false);
    expect(out.diagnostics.hadCodeFence).toBe(true);
  });
});
