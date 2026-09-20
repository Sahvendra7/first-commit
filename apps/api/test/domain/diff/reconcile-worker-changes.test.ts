/**
 * `reconcileWorkerChanges` — the worker must never overwrite a human.
 *
 * The race is real and ordinary: with the suggestion layer off, the review
 * screen is the *primary* way a change list comes to exist
 * (`docs/web-contract.md` §0.2), so a tenant can be annotating a room while
 * the diff job for that tenancy is still running. A worker that writes its
 * own list over the top silently deletes the tenant's evidence.
 *
 * Rule 1 of `human-edits.ts` applies here verbatim: a model re-run is new
 * evidence about the photographs, never new evidence about what the tenant
 * decided.
 */
import { describe, expect, it } from 'vitest';
import type { DiffChange } from '@handover/shared';
import { reconcileWorkerChanges } from '../../../src/domain/diff/room-outcome.js';

const model = (id: string, description = 'a dark stain', tenantAction?: 'ACCEPT' | 'REJECT'): DiffChange => ({
  id,
  type: 'STAIN',
  surface: 'WALL',
  location: 'wall left of the window',
  description,
  confidence: 0.7,
  source: 'MODEL',
  ...(tenantAction ? { tenantAction } : {}),
});

const tenant = (id: string, description = 'chipped skirting'): DiffChange => ({
  id,
  type: 'CHIP',
  location: 'skirting by the door',
  description,
  confidence: 1,
  source: 'TENANT',
  tenantAction: 'ACCEPT',
});

describe('reconcileWorkerChanges — tenant-authored changes', () => {
  it('keeps a change the tenant wrote while the job was running', () => {
    const result = reconcileWorkerChanges([tenant('t1')], [model('m1')]);

    expect(result.map((c) => c.id)).toEqual(['t1', 'm1']);
    expect(result[0]?.source).toBe('TENANT');
  });

  it('keeps every tenant-authored change when the worker produced none', () => {
    const result = reconcileWorkerChanges([tenant('t1'), tenant('t2')], []);
    expect(result.map((c) => c.id)).toEqual(['t1', 't2']);
  });

  it('never alters a tenant-authored change', () => {
    const original = tenant('t1');
    const [kept] = reconcileWorkerChanges([original], [model('m1')]);
    expect(kept).toEqual(original);
  });
});

describe('reconcileWorkerChanges — decisions the tenant already made', () => {
  it('keeps a model change the tenant accepted, with its decision intact', () => {
    const accepted = model('m1', 'a dark stain', 'ACCEPT');
    const result = reconcileWorkerChanges([accepted], [model('m2')]);

    expect(result.map((c) => c.id)).toEqual(['m1', 'm2']);
    expect(result[0]?.tenantAction).toBe('ACCEPT');
  });

  it('keeps a rejection on the record rather than resurrecting the change', () => {
    // §9.7 and human-edits.ts: rejections are marked, never deleted. An audit
    // trail with silent removals is not evidence of anything.
    const rejected = model('m1', 'a dark stain', 'REJECT');
    const result = reconcileWorkerChanges([rejected], [model('m1', 'a dark stain')]);

    expect(result).toHaveLength(1);
    expect(result[0]?.tenantAction).toBe('REJECT');
  });

  it('does not let a fresh model run un-accept a change', () => {
    const accepted = model('m1', 'a dark stain', 'ACCEPT');
    const result = reconcileWorkerChanges([accepted], [model('m1', 'a dark stain')]);

    expect(result).toHaveLength(1);
    expect(result[0]?.tenantAction).toBe('ACCEPT');
  });
});

describe('reconcileWorkerChanges — stale suggestions', () => {
  it('replaces an unreviewed model suggestion from an earlier run', () => {
    const stale = model('old', 'an earlier wording');
    const result = reconcileWorkerChanges([stale], [model('fresh', 'the current wording')]);

    expect(result.map((c) => c.id)).toEqual(['fresh']);
  });

  it('drops an unreviewed suggestion even when the new run produced nothing', () => {
    const result = reconcileWorkerChanges([model('old')], []);
    expect(result).toEqual([]);
  });
});

describe('reconcileWorkerChanges — shape', () => {
  it('returns an empty list when there is nothing on either side', () => {
    expect(reconcileWorkerChanges([], [])).toEqual([]);
  });

  it('puts human-owned changes before fresh suggestions', () => {
    const result = reconcileWorkerChanges(
      [tenant('t1'), model('m_accepted', 'x', 'ACCEPT')],
      [model('m_new')],
    );
    expect(result.map((c) => c.id)).toEqual(['t1', 'm_accepted', 'm_new']);
  });

  it('mutates neither input', () => {
    const existing = [tenant('t1')];
    const produced = [model('m1')];
    reconcileWorkerChanges(existing, produced);

    expect(existing).toHaveLength(1);
    expect(produced).toHaveLength(1);
  });

  it('is deterministic', () => {
    const existing = [tenant('t1'), model('m1', 'x', 'REJECT')];
    const produced = [model('m1'), model('m2')];
    expect(reconcileWorkerChanges(existing, produced)).toEqual(
      reconcileWorkerChanges(existing, produced),
    );
  });
});
