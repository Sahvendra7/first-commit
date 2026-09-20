import { describe, expect, it } from 'vitest';
import { roomDiffSchema } from '@handover/shared';
import type { DiffChange } from '@handover/shared';
import { applyPatchToChanges } from '../../../src/domain/diff/patch-room.js';

/**
 * `PATCH /v1/tenancies/{id}/diff/{roomId}` — architecture.md §7, §9.2, §9.7.
 *
 * §7: "the model will be wrong sometimes, and the human must own the final
 * record." This fold is where that ownership is executed, so the tests below
 * are mostly about what the fold refuses to do: invent a confidence, lose a
 * decision, drop a rejection, or renumber somebody else's change.
 *
 * Pure function, so none of this needs AWS.
 */

const MODEL_CHANGE: DiffChange = {
  id: 'chg_model_1',
  type: 'STAIN',
  surface: 'WALL',
  location: 'wall left of the window',
  description: 'A dark patch about the size of a hand.',
  confidence: 0.82,
  source: 'MODEL',
};

const SECOND_MODEL_CHANGE: DiffChange = {
  ...MODEL_CHANGE,
  id: 'chg_model_2',
  surface: 'FLOOR',
  location: 'floor by the door',
  description: 'A long scratch across two boards.',
  confidence: 0.4,
};

/** Deterministic id minting, so assertions can name the result. */
const ids = (): (() => string) => {
  let n = 0;
  return () => `chg_new_${(n += 1)}`;
};

const apply = (
  existing: readonly DiffChange[],
  request: { changes?: { id: string; action: 'ACCEPT' | 'REJECT' }[]; additions?: unknown[] },
): DiffChange[] =>
  applyPatchToChanges({
    existing,
    changes: request.changes ?? [],
    additions: (request.additions ?? []) as never,
    newChangeId: ids(),
  });

describe('accept and reject', () => {
  it('marks a model suggestion accepted', () => {
    const [change] = apply([MODEL_CHANGE], {
      changes: [{ id: 'chg_model_1', action: 'ACCEPT' }],
    });
    expect(change!.tenantAction).toBe('ACCEPT');
  });

  it('marks a model suggestion rejected', () => {
    const [change] = apply([MODEL_CHANGE], {
      changes: [{ id: 'chg_model_1', action: 'REJECT' }],
    });
    expect(change!.tenantAction).toBe('REJECT');
  });

  /**
   * §9.7 and the audit trail: "Rejections are kept on the record rather than
   * deleted... a change list with silent removals is not evidence of anything."
   */
  it('keeps a rejected change on the record rather than deleting it', () => {
    const result = apply([MODEL_CHANGE], {
      changes: [{ id: 'chg_model_1', action: 'REJECT' }],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('chg_model_1');
  });

  it('leaves an untouched change exactly as it was', () => {
    const result = apply([MODEL_CHANGE, SECOND_MODEL_CHANGE], {
      changes: [{ id: 'chg_model_1', action: 'ACCEPT' }],
    });
    expect(result[1]).toEqual(SECOND_MODEL_CHANGE);
    expect(result[1]!.tenantAction).toBeUndefined();
  });

  it('preserves every provenance field of an accepted suggestion', () => {
    const [change] = apply([MODEL_CHANGE], {
      changes: [{ id: 'chg_model_1', action: 'ACCEPT' }],
    });
    expect(change).toMatchObject({
      id: 'chg_model_1',
      type: 'STAIN',
      surface: 'WALL',
      location: 'wall left of the window',
      description: 'A dark patch about the size of a hand.',
      confidence: 0.82,
      source: 'MODEL',
    });
  });

  it('applies the last decision when one change is decided twice', () => {
    const [change] = apply([MODEL_CHANGE], {
      changes: [
        { id: 'chg_model_1', action: 'ACCEPT' },
        { id: 'chg_model_1', action: 'REJECT' },
      ],
    });
    expect(change!.tenantAction).toBe('REJECT');
  });

  it('lets the tenant change their mind across two calls', () => {
    const once = apply([MODEL_CHANGE], { changes: [{ id: 'chg_model_1', action: 'REJECT' }] });
    const twice = apply(once, { changes: [{ id: 'chg_model_1', action: 'ACCEPT' }] });
    expect(twice[0]!.tenantAction).toBe('ACCEPT');
  });

  /**
   * An unknown id is ignored rather than conjured into a change, mirroring
   * `human-edits.ts`. The response carries the real list, and the web contract
   * tells the client to render from the response — so a stale id shows up as
   * a change that simply is not there, rather than as a fabricated one.
   */
  it('ignores a decision about an id that is not on the room', () => {
    const result = apply([MODEL_CHANGE], { changes: [{ id: 'chg_ghost', action: 'ACCEPT' }] });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('chg_model_1');
    expect(result[0]!.tenantAction).toBeUndefined();
  });
});

describe('tenant additions', () => {
  const ADDITION = {
    type: 'CRACK' as const,
    surface: 'CEILING' as const,
    location: 'ceiling above the fan',
    description: 'A hairline crack running about a foot.',
  };

  it('appends the addition to the room', () => {
    const result = apply([MODEL_CHANGE], { additions: [ADDITION] });
    expect(result).toHaveLength(2);
    expect(result[1]!.description).toBe('A hairline crack running about a foot.');
  });

  it('marks the addition as tenant-authored', () => {
    const [, added] = apply([MODEL_CHANGE], { additions: [ADDITION] });
    expect(added!.source).toBe('TENANT');
  });

  /**
   * §9.7: only what the tenant affirmatively accepts may reach a document.
   * Authoring a change *is* that affirmation, so it is accepted on arrival.
   */
  it('treats authoring as acceptance', () => {
    const [added] = apply([], { additions: [ADDITION] });
    expect(added!.source).toBe('TENANT');
    expect(added!.tenantAction).toBe('ACCEPT');
  });

  it('takes its id from the server, never from the client', () => {
    const [added] = apply([], { additions: [ADDITION] });
    expect(added!.id).toBe('chg_new_1');
  });

  it('gives each addition in one batch a distinct id', () => {
    const result = apply([], { additions: [ADDITION, { ...ADDITION, description: 'Another.' }] });
    expect(new Set(result.map((c) => c.id)).size).toBe(2);
  });

  /**
   * §0.2 of the web contract, and the reason `diffAdditionSchema` has no
   * confidence field: "A human assertion is not a sampled one."
   *
   * `diffChangeSchema.confidence` is nonetheless required, so the value has to
   * be *something*. It is recorded as 1 to satisfy the frozen shape and is
   * never read: the UI switches on `source`, the merge never sees it, and the
   * document gate is provenance, not confidence. This matches the demo client
   * byte for byte so the real API and `?demo=1` cannot diverge.
   */
  it('records no model confidence of its own', () => {
    const [added] = apply([], { additions: [ADDITION] });
    expect(added!.confidence).toBe(1);
    expect(added!.source).toBe('TENANT');
  });

  it('carries no wear-and-tear argument, which only a model produces', () => {
    const [added] = apply([], { additions: [ADDITION] });
    expect(added!.wearAndTear).toBeUndefined();
  });

  it('accepts an addition with no surface', () => {
    const { surface: _omitted, ...noSurface } = ADDITION;
    const [added] = apply([], { additions: [noSurface] });
    expect(added!.surface).toBeUndefined();
    expect(added!.type).toBe('CRACK');
  });

  it('is a complete request on its own, with no decisions', () => {
    const result = apply([], { additions: [ADDITION] });
    expect(result).toHaveLength(1);
  });
});

describe('mixed and repeated calls', () => {
  it('applies accepts, rejects and additions in one call', () => {
    const result = apply([MODEL_CHANGE, SECOND_MODEL_CHANGE], {
      changes: [
        { id: 'chg_model_1', action: 'ACCEPT' },
        { id: 'chg_model_2', action: 'REJECT' },
      ],
      additions: [
        {
          type: 'HOLE',
          location: 'wall behind the door',
          description: 'A screw hole about 5mm across.',
        },
      ],
    });

    expect(result).toHaveLength(3);
    expect(result[0]!.tenantAction).toBe('ACCEPT');
    expect(result[1]!.tenantAction).toBe('REJECT');
    expect(result[2]!.source).toBe('TENANT');
  });

  it('is stable when the identical patch is replayed', () => {
    const request = { changes: [{ id: 'chg_model_1', action: 'ACCEPT' as const }] };
    const once = apply([MODEL_CHANGE], request);
    const twice = apply(once, request);
    expect(twice).toEqual(once);
  });

  /**
   * A replayed *addition* is not idempotent by id — the server mints a new one
   * each time — so a duplicate description is not silently collapsed. That is
   * the honest behaviour: two identical descriptions may be two real defects,
   * and the record is the tenant's to curate.
   */
  it('appends again when the same addition is sent twice', () => {
    const addition = {
      type: 'DENT' as const,
      location: 'door edge',
      description: 'A dent near the handle.',
    };
    // One id source across both calls, as in production, where `newChangeId`
    // is a UUID minter that never repeats for the life of the tenancy.
    const newChangeId = ids();
    const call = (existing: readonly DiffChange[]): DiffChange[] =>
      applyPatchToChanges({ existing, changes: [], additions: [addition], newChangeId });

    const twice = call(call([]));

    expect(twice).toHaveLength(2);
    expect(twice[0]!.id).not.toBe(twice[1]!.id);
  });

  it('never mutates the array it was given', () => {
    const existing = [MODEL_CHANGE];
    const frozen = JSON.stringify(existing);
    apply(existing, {
      changes: [{ id: 'chg_model_1', action: 'REJECT' }],
      additions: [{ type: 'BURN', location: 'worktop', description: 'A scorch mark.' }],
    });
    expect(JSON.stringify(existing)).toBe(frozen);
  });

  it('produces changes that satisfy the frozen wire schema', () => {
    const result = apply([MODEL_CHANGE], {
      changes: [{ id: 'chg_model_1', action: 'ACCEPT' }],
      additions: [{ type: 'MOULD', location: 'window reveal', description: 'Black spotting.' }],
    });

    expect(() =>
      roomDiffSchema.parse({
        roomId: 'r_1',
        roomLabel: 'Kitchen',
        status: 'NEEDS_REVIEW',
        changes: result,
      }),
    ).not.toThrow();
  });
});
