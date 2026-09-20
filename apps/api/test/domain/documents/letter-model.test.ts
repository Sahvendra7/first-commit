/**
 * `domain/documents/letter-model.ts` — architecture.md §5.6, §8.3, §9.2, §9.7;
 * `demo-safety`.
 *
 * The demand letter is the document in this system with the most to lose. It
 * goes to a landlord, it asserts a debt, and it names a statute. So everything
 * it is allowed to say is decided here, in pure code, before a byte of PDF
 * exists — and these tests are the list of things it may and may not say.
 *
 * Four properties, each guarding a specific way this document could do harm:
 *
 *  1. **Every figure comes from `domain/claim`.** The model does no arithmetic
 *     of its own. A second implementation of the shortfall would be a second
 *     chance to get it wrong.
 *  2. **Every statutory statement comes from the reviewed table.** No citation,
 *     deadline or authority name is written here, and none may be invented.
 *  3. **An unreviewed rule table cannot masquerade as a reviewed one.** R9:
 *     `lastReviewedAt` absent means the letter says so, in its own text.
 *  4. **Only what the tenant accepted reaches the annexure** (§9.7), with the
 *     origin marker intact and the model's `confidence` nowhere in sight
 *     (§9.2).
 */
import { describe, expect, it } from 'vitest';
import { toPaise } from '@handover/shared';
import type { DiffChange, HandoverItem, Paise, StateRuleItem } from '@handover/shared';
import { buildLetterModel } from '../../../src/domain/documents/letter-model.js';

const p = (n: number): Paise => toPaise(n);

const rule = (over: Partial<StateRuleItem> = {}): StateRuleItem => ({
  PK: 'STATE#KA',
  SK: 'RULES',
  entityType: 'STATE_RULE',
  stateCode: 'KA',
  stateName: 'Karnataka',
  mtaAdopted: false,
  depositCapMonths: 0,
  refundWindowDays: 30,
  statutoryInterestBps: 0,
  authorityName: 'Court of Small Causes, Bengaluru',
  escalationSteps: [
    { order: 0, label: 'Written demand to the landlord', description: 'Send a dated demand.', afterDays: 0 },
    { order: 1, label: 'Legal notice', description: 'A formal notice through an advocate.', afterDays: 15 },
  ],
  statuteRefs: [{ citation: 'Karnataka Rent Act, 1999', title: 'The operative rent legislation' }],
  updatedAt: '2026-09-20T00:00:00.000Z',
  ...over,
});

const TENANCY = {
  PK: 'TENANCY#t_1',
  SK: 'META',
  entityType: 'TENANCY',
  tenancyId: 't_1',
  ownerSub: 'sub-1',
  addressLine: '12 Ashoka Road',
  city: 'Bengaluru',
  stateCode: 'KA',
  monthlyRentPaise: p(4_500_000),
  depositPaise: p(27_000_000),
  moveInDate: '2025-04-01',
  handoverDate: '2026-09-01',
  landlordEmail: 'landlord@example.com',
  status: 'AWAITING_REFUND',
  createdAt: '2025-04-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  GSI1PK: 'USER#sub-1',
  GSI1SK: 'TENANCY#2025-04-01T00:00:00.000Z',
} as unknown as HandoverItem;

const ROOM = {
  PK: 'TENANCY#t_1',
  SK: 'ROOM#r1',
  entityType: 'ROOM',
  tenancyId: 't_1',
  roomId: 'r1',
  label: 'Kitchen',
  orderIndex: 0,
  photoCountMovein: 1,
  photoCountMoveout: 1,
} as unknown as HandoverItem;

const photo = (phase: 'MOVEIN' | 'MOVEOUT', n: number): HandoverItem =>
  ({
    PK: 'TENANCY#t_1',
    SK: `PHOTO#${phase}#r1#000${n}`,
    entityType: 'PHOTO',
    tenancyId: 't_1',
    roomId: 'r1',
    photoId: `p_${phase}_${n}`,
    phase,
    s3Key: `tenancies/t_1/${phase}/r1/p${n}.jpg`,
    sha256: (phase === 'MOVEIN' ? 'a' : 'b').repeat(64),
    bytes: 2048,
    receivedAt: `2026-0${phase === 'MOVEIN' ? '4' : '9'}-01T10:00:00.000Z`,
    pairIndex: n,
  }) as unknown as HandoverItem;

const change = (over: Partial<DiffChange> = {}): DiffChange => ({
  id: 'chg_1',
  type: 'STAIN',
  surface: 'WALL',
  location: 'wall left of the window',
  description: 'A dark stain roughly 20cm across.',
  confidence: 0.82,
  source: 'MODEL',
  tenantAction: 'ACCEPT',
  ...over,
});

const diff = (changes: DiffChange[]): HandoverItem =>
  ({
    PK: 'TENANCY#t_1',
    SK: 'DIFF#r1',
    entityType: 'DIFF',
    tenancyId: 't_1',
    roomId: 'r1',
    status: 'COMPLETE',
    changes,
  }) as unknown as HandoverItem;

const items = (changes: DiffChange[] = [change()]): HandoverItem[] => [
  TENANCY,
  ROOM,
  photo('MOVEIN', 0),
  photo('MOVEOUT', 0),
  diff(changes),
];

const build = (over: Partial<Parameters<typeof buildLetterModel>[0]> = {}) =>
  buildLetterModel({
    items: items(),
    rule: rule(),
    claimInput: {
      claimedDeductionsPaise: p(5_000_000),
      deductionReasons: ['Repainting the kitchen wall'],
      amountReceivedPaise: p(0),
    },
    asOfDate: '2026-10-15',
    generatedAt: '2026-10-15T09:30:00.000Z',
    ...over,
  });

describe('buildLetterModel — the figures come from domain/claim', () => {
  it('states the deposit, the deductions and the shortfall the arithmetic produced', () => {
    const m = build();

    expect(m.claim.depositPaise).toBe(27_000_000);
    expect(m.claim.claimedDeductionsPaise).toBe(5_000_000);
    expect(m.claim.expectedRefundPaise).toBe(22_000_000);
    expect(m.claim.outstanding).toEqual({ direction: 'OWED_TO_TENANT', amount: 22_000_000 });
    expect(m.claim.totalClaimedPaise).toBe(22_000_000);
  });

  it('takes the refund deadline from the rule rather than restating a window', () => {
    // Handover 2026-09-01 + Karnataka's 30-day window.
    const m = build();
    expect(m.claim.refundDueDate).toBe('2026-10-01');
    expect(m.claim.daysOverdue).toBe(14);
  });

  it('carries the landlord’s stated reasons verbatim, as their claim and not as fact', () => {
    const m = build();
    expect(m.deductionReasons).toEqual(['Repainting the kitchen wall']);
  });

  it('refuses to build a letter when nothing is owed', () => {
    expect(() =>
      build({
        claimInput: {
          claimedDeductionsPaise: p(0),
          deductionReasons: [],
          amountReceivedPaise: p(27_000_000),
        },
      }),
    ).toThrow(/settled/i);
  });
});

describe('buildLetterModel — statutory content is reviewed data, never invented', () => {
  it('carries the authority and the citations from the rule item', () => {
    const m = build();
    expect(m.rules.authorityName).toBe('Court of Small Causes, Bengaluru');
    expect(m.rules.statuteRefs).toEqual([
      { citation: 'Karnataka Rent Act, 1999', title: 'The operative rent legislation' },
    ]);
  });

  it('carries the escalation ladder in the order the table gives it', () => {
    const m = build({ rule: rule({ escalationSteps: [
      { order: 1, label: 'Legal notice', description: 'Second.' },
      { order: 0, label: 'Written demand', description: 'First.' },
    ] }) });
    expect(m.rules.escalationSteps.map((s) => s.label)).toEqual(['Written demand', 'Legal notice']);
  });

  /**
   * R9. `data/state-rules/KA.json` ships with `lastReviewedAt` absent, and the
   * absence is the signal. A letter built on an unreviewed table must say so
   * on its own face — the alternative is a document that looks reviewed
   * because nothing on it says otherwise.
   */
  it('reports an unreviewed rule table as unreviewed', () => {
    const m = build();
    expect(m.rules.reviewed).toBe(false);
    expect(m.rules.lastReviewedAt).toBeUndefined();
  });

  it('reports a reviewed rule table as reviewed, and says when', () => {
    const m = build({ rule: rule({ lastReviewedAt: '2026-08-01' }) });
    expect(m.rules.reviewed).toBe(true);
    expect(m.rules.lastReviewedAt).toBe('2026-08-01');
  });

  it('never invents a review date from the item’s write timestamp', () => {
    const m = build({ rule: rule({ updatedAt: '2026-09-20T00:00:00.000Z' }) });
    expect(m.rules.lastReviewedAt).toBeUndefined();
  });
});

describe('buildLetterModel — the evidence annexure', () => {
  it('counts the photographs on both sides of each room', () => {
    const m = build();
    expect(m.evidence.rooms).toHaveLength(1);
    expect(m.evidence.rooms[0]).toMatchObject({ roomId: 'r1', label: 'Kitchen' });
    expect(m.evidence.rooms[0]!.movein).toHaveLength(1);
    expect(m.evidence.rooms[0]!.moveout).toHaveLength(1);
  });

  it('carries each photograph’s digest and server timestamp', () => {
    const shot = build().evidence.rooms[0]!.movein[0]!;
    expect(shot.sha256).toBe('a'.repeat(64));
    expect(shot.receivedAt).toBe('2026-04-01T10:00:00.000Z');
  });

  /** §9.7: only an affirmatively accepted change may enter a letter. */
  it('admits a change the tenant accepted', () => {
    const m = build();
    expect(m.evidence.rooms[0]!.recordedChanges.map((c) => c.id)).toEqual(['chg_1']);
  });

  it('excludes a change the tenant rejected', () => {
    const m = build({ items: items([change({ tenantAction: 'REJECT' })]) });
    expect(m.evidence.rooms[0]!.recordedChanges).toEqual([]);
  });

  it('excludes a suggestion the tenant never reviewed', () => {
    const m = build({ items: items([change({ tenantAction: undefined })]) });
    expect(m.evidence.rooms[0]!.recordedChanges).toEqual([]);
  });

  it('marks an accepted suggestion as one, distinctly from what the tenant wrote', () => {
    const m = build({
      items: items([
        change({ id: 'chg_m', source: 'MODEL' }),
        change({ id: 'chg_t', source: 'TENANT', confidence: 1 }),
      ]),
    });
    const origins = Object.fromEntries(
      m.evidence.rooms[0]!.recordedChanges.map((c) => [c.id, c.origin]),
    );
    expect(origins).toEqual({
      chg_m: 'TENANT_ACCEPTED_SUGGESTION',
      chg_t: 'TENANT_RECORDED',
    });
  });

  /**
   * §9.2: the model's own number may never enter a generated document. It is
   * not copied and then hidden — it never reaches the model at all. The
   * `confidence: 1` a tenant-authored change carries for schema compatibility
   * is not model confidence and must not travel either.
   */
  it('carries no confidence anywhere in the model', () => {
    const m = build({
      items: items([change({ id: 'chg_t', source: 'TENANT', confidence: 1 })]),
    });
    expect(JSON.stringify(m)).not.toContain('confidence');
  });

  it('totals the photographs and the accepted changes', () => {
    const m = build();
    expect(m.evidence.totals).toEqual({ roomCount: 1, photoCount: 2, recordedChangeCount: 1 });
  });
});

describe('buildLetterModel — determinism and purity', () => {
  it('is a pure function of its inputs', () => {
    expect(build()).toEqual(build());
  });

  it('uses the injected generation instant rather than a clock', () => {
    expect(build({ generatedAt: '2027-01-02T03:04:05.000Z' }).generatedAt).toBe(
      '2027-01-02T03:04:05.000Z',
    );
  });

  it('refuses a partition with no tenancy', () => {
    expect(() => build({ items: [ROOM] })).toThrow();
  });

  it('refuses a tenancy with no handover date — there is no clock to run', () => {
    const noHandover = { ...(TENANCY as unknown as Record<string, unknown>) };
    delete noHandover['handoverDate'];
    expect(() => build({ items: [noHandover as unknown as HandoverItem, ROOM] })).toThrow(
      /handover/i,
    );
  });
});
