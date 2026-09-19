import { describe, expect, it } from 'vitest';
import {
  CLOCK_PENDING_PK,
  GSI1_NAME,
  GSI2_NAME,
  InvalidKeyComponentError,
  MAX_PHOTO_INDEX,
  diffCachePk,
  diffCacheSk,
  diffSk,
  diffSkPrefix,
  documentSk,
  documentSkPrefix,
  gsi1Pk,
  gsi1Sk,
  gsi2Pk,
  gsi2Sk,
  jobPk,
  jobSk,
  key,
  photoSk,
  photoSkPhasePrefix,
  photoSkPrefix,
  roomSk,
  roomSkPrefix,
  statePk,
  stateRulesSk,
  tenancyMetaSk,
  tenancyPk,
} from '../src/types/keys.js';

/**
 * These assert the literal key strings from the architecture.md §6.2
 * access-pattern table. If one of these changes, it is a data migration, and
 * the test failing is the point.
 */

describe('§6.2 access-pattern key shapes', () => {
  it('AP-1 — tenancy metadata', () => {
    expect(tenancyPk('t123')).toBe('TENANCY#t123');
    expect(tenancyMetaSk()).toBe('META');
    expect(key.tenancyMeta('t123')).toEqual({ PK: 'TENANCY#t123', SK: 'META' });
  });

  it('AP-2 — children share the tenancy partition', () => {
    const pk = tenancyPk('t123');
    expect(key.room('t123', 'r1').PK).toBe(pk);
    expect(key.photo('t123', 'MOVEIN', 'r1', 0).PK).toBe(pk);
    expect(key.diff('t123', 'r1').PK).toBe(pk);
    expect(key.document('t123', 'd1').PK).toBe(pk);
  });

  it('AP-3 — photo sort key and its begins_with prefix', () => {
    expect(photoSkPrefix('MOVEIN', 'r1')).toBe('PHOTO#MOVEIN#r1#');
    expect(photoSk('MOVEIN', 'r1', 0)).toBe('PHOTO#MOVEIN#r1#0000');
    expect(photoSk('MOVEOUT', 'r1', 7)).toBe('PHOTO#MOVEOUT#r1#0007');
    expect(photoSk('MOVEIN', 'r1', 3).startsWith(photoSkPrefix('MOVEIN', 'r1'))).toBe(true);
    expect(photoSkPhasePrefix('MOVEOUT')).toBe('PHOTO#MOVEOUT#');
  });

  it('AP-3 — ordinals are zero-padded so lexicographic order is numeric order', () => {
    const keys = [10, 2, 1, 100].map((n) => photoSk('MOVEIN', 'r1', n));
    expect([...keys].sort()).toEqual([
      'PHOTO#MOVEIN#r1#0001',
      'PHOTO#MOVEIN#r1#0002',
      'PHOTO#MOVEIN#r1#0010',
      'PHOTO#MOVEIN#r1#0100',
    ]);
  });

  it('AP-3 — rejects an out-of-range or fractional ordinal', () => {
    expect(() => photoSk('MOVEIN', 'r1', -1)).toThrow(InvalidKeyComponentError);
    expect(() => photoSk('MOVEIN', 'r1', 1.5)).toThrow(InvalidKeyComponentError);
    expect(() => photoSk('MOVEIN', 'r1', MAX_PHOTO_INDEX + 1)).toThrow(InvalidKeyComponentError);
    expect(photoSk('MOVEIN', 'r1', MAX_PHOTO_INDEX)).toBe('PHOTO#MOVEIN#r1#9999');
  });

  it('room, diff and document sort keys with their prefixes', () => {
    expect(roomSk('r1')).toBe('ROOM#r1');
    expect(roomSkPrefix()).toBe('ROOM#');
    expect(diffSk('r1')).toBe('DIFF#r1');
    expect(diffSkPrefix()).toBe('DIFF#');
    expect(documentSk('d1')).toBe('DOCUMENT#d1');
    expect(documentSkPrefix()).toBe('DOCUMENT#');
  });

  it('AP-6 — job', () => {
    expect(jobPk('j1')).toBe('JOB#j1');
    expect(jobSk()).toBe('META');
    expect(key.job('j1')).toEqual({ PK: 'JOB#j1', SK: 'META' });
  });

  it('AP-7 — state rules, case-normalised', () => {
    expect(statePk('KA')).toBe('STATE#KA');
    expect(statePk('ka')).toBe('STATE#KA');
    expect(statePk(' ka ')).toBe('STATE#KA');
    expect(stateRulesSk()).toBe('RULES');
  });

  it('AP-8 — diff cache', () => {
    expect(diffCachePk('abc123')).toBe('DIFFCACHE#abc123');
    expect(diffCacheSk()).toBe('RESULT');
  });

  it('AP-4 — GSI1, a user\'s tenancies', () => {
    expect(GSI1_NAME).toBe('GSI1');
    expect(gsi1Pk('sub-abc')).toBe('USER#sub-abc');
    expect(gsi1Sk('2026-09-19T09:00:00.000Z')).toBe('TENANCY#2026-09-19T09:00:00.000Z');
  });

  it('AP-4 — GSI1SK sorts chronologically as a string', () => {
    const sks = ['2026-01-02T00:00:00.000Z', '2025-12-31T23:59:59.000Z', '2026-01-10T00:00:00.000Z']
      .map(gsi1Sk);
    expect([...sks].sort()).toEqual([
      'TENANCY#2025-12-31T23:59:59.000Z',
      'TENANCY#2026-01-02T00:00:00.000Z',
      'TENANCY#2026-01-10T00:00:00.000Z',
    ]);
  });

  it('AP-5 — GSI2 is a single sparse partition keyed by due date', () => {
    expect(GSI2_NAME).toBe('GSI2');
    expect(gsi2Pk()).toBe('CLOCK#PENDING');
    expect(gsi2Pk()).toBe(CLOCK_PENDING_PK);
    expect(gsi2Sk('2026-09-19')).toBe('2026-09-19');
  });

  it('AP-5 — the sweep\'s "SK <= today" comparison works on the raw string', () => {
    const due = ['2026-09-20', '2026-09-18', '2026-09-19'].map(gsi2Sk);
    const today = '2026-09-19';
    expect(due.filter((d) => d <= today).sort()).toEqual(['2026-09-18', '2026-09-19']);
  });
});

describe('key component validation', () => {
  it.each(['', '   '])('rejects the empty component %p', (v) => {
    expect(() => tenancyPk(v)).toThrow(/empty/);
  });

  it('rejects an id containing the reserved separator, which could forge a key', () => {
    expect(() => tenancyPk('t1#META')).toThrow(/reserved/);
    expect(() => roomSk('r1#x')).toThrow(/reserved/);
    expect(() => jobPk('j1#META')).toThrow(/reserved/);
    expect(() => gsi1Pk('sub#other')).toThrow(/reserved/);
  });

  it('rejects a non-string component at runtime', () => {
    expect(() => tenancyPk(undefined as unknown as string)).toThrow(/not a string/);
    expect(() => tenancyPk(42 as unknown as string)).toThrow(/not a string/);
  });

  it('trims surrounding whitespace rather than embedding it in a key', () => {
    expect(tenancyPk('  t123  ')).toBe('TENANCY#t123');
  });

  it('names the offending component in the error message', () => {
    expect(() => roomSk('')).toThrow(/"roomId"/);
    expect(() => diffCachePk('')).toThrow(/"cacheKey"/);
  });
});
