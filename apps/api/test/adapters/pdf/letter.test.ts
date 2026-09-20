import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { pdfProse, pdfText } from '../../support/pdf-text.js';
import { renderLetter } from '../../../src/adapters/pdf/letter.js';
import { toPaise } from '@handover/shared';
import { recordRefFor } from '../../../src/domain/documents/report-model.js';
import type { LetterModel } from '../../../src/domain/documents/letter-model.js';

/**
 * The rendered demand letter — architecture.md §5.6, §8.3; `demo-safety`.
 *
 * Every assertion below reads the **produced bytes**, inflating the content
 * streams to recover the text the page actually draws. Asserting on the model
 * instead would let the template say anything at all while the test stayed
 * green, and the template is exactly where the copy rules hold or fail.
 *
 * The negative assertions are the important ones. "The letter must not claim
 * admissibility" is only worth something if the extractor can genuinely read
 * the text — otherwise `not.toContain` passes for every possible input.
 */

const AT = '2026-10-15T09:30:00.000Z';

const p = (n: number) => toPaise(n);

const photo = (phase: 'MOVEIN' | 'MOVEOUT', n: number) => ({
  photoId: `p_${phase}_${n}`,
  phase,
  pairIndex: n,
  sha256: `${'ab'.repeat(31)}${phase === 'MOVEIN' ? 'cd' : 'ef'}`,
  bytes: 240_000,
  receivedAt: phase === 'MOVEIN' ? '2025-04-01T10:00:00.000Z' : '2026-09-01T10:00:00.000Z',
  s3Key: `tenancies/t1/${phase}/r1/${n}.jpg`,
});

const model = (over: Partial<LetterModel> = {}): LetterModel => ({
  docType: 'DEMAND_LETTER',
  tenancy: {
    tenancyId: 't1',
    addressLine: '12 Ashoka Road',
    city: 'Bengaluru',
    stateCode: 'KA',
    moveInDate: '2025-04-01',
    handoverDate: '2026-09-01',
  },
  landlordEmail: 'landlord@example.com',
  claim: {
    depositPaise: p(27_000_000),
    claimedDeductionsPaise: p(5_000_000),
    deductionsExceedDeposit: false,
    expectedRefundPaise: p(22_000_000),
    amountReceivedPaise: p(0),
    outstanding: { direction: 'OWED_TO_TENANT', amount: p(22_000_000) },
    isSettled: false,
    refundDueDate: '2026-10-01',
    asOfDate: '2026-10-15',
    daysOverdue: 14,
    interest: { claimed: false, reason: 'NO_STATUTORY_RATE' },
    totalClaimedPaise: p(22_000_000),
  },
  deductionReasons: ['Repainting the kitchen wall'],
  evidence: {
    rooms: [
      {
        roomId: 'r1',
        label: 'Kitchen',
        orderIndex: 0,
        movein: [photo('MOVEIN', 0)],
        moveout: [photo('MOVEOUT', 0)],
        recordedChanges: [
          {
            id: 'chg_1',
            type: 'STAIN',
            surface: 'WALL',
            location: 'wall left of the window',
            description: 'A dark stain roughly 20cm across.',
            origin: 'TENANT_ACCEPTED_SUGGESTION',
          },
        ],
      },
    ],
    totals: { roomCount: 1, photoCount: 2, recordedChangeCount: 1 },
  },
  rules: {
    stateCode: 'KA',
    stateName: 'Karnataka',
    authorityName: 'Court of Small Causes, Bengaluru',
    refundWindowDays: 30,
    statutoryInterestBps: 0,
    escalationSteps: [
      { order: 0, label: 'Written demand to the landlord', description: 'Send a dated demand.' },
      { order: 1, label: 'Legal notice', description: 'A formal notice through an advocate.' },
    ],
    statuteRefs: [{ citation: 'Karnataka Rent Act, 1999', title: 'The operative rent legislation' }],
    reviewed: false,
  },
  generatedAt: AT,
  ...over,
});

const render = async (over: Partial<LetterModel> = {}) => {
  const m = model(over);
  const ref = recordRefFor(m.tenancy.tenancyId, 'DEMAND_LETTER', m.generatedAt);
  const out = await renderLetter(m, ref);
  return { ...out, text: pdfText(out.bytes), prose: pdfProse(out.bytes), ref };
};

describe('renderLetter — the money on the page', () => {
  it('prints the deposit, the deductions and the shortfall in rupees', async () => {
    const { text } = await render();

    expect(text).toContain('2,70,000.00'); // deposit
    expect(text).toContain('50,000.00'); // claimed deductions
    expect(text).toContain('2,20,000.00'); // shortfall and total claimed
  });

  /**
   * The rupee sign is U+20B9, which the WinAnsi encoding behind the standard
   * PDF fonts cannot represent — `sanitise` drops it, and every figure on the
   * page would otherwise be a bare number. A demand letter that states an
   * amount without naming the currency is ambiguous in exactly the document
   * where ambiguity is most expensive, so the currency is written as a word.
   */
  it('names the currency on every amount rather than relying on a symbol', async () => {
    const { text } = await render();

    expect(text).toContain('INR 2,70,000.00');
    expect(text).toContain('INR 50,000.00');
    expect(text).toContain('INR 2,20,000.00');
    expect(text).not.toContain('\u20b9');
  });

  it('prints the total demanded', async () => {
    const { text } = await render();
    expect(text).toMatch(/Total (amount )?(now )?(demanded|claimed)/i);
  });

  it('prints the refund deadline and how far past it the claim is', async () => {
    const { text } = await render();
    expect(text).toContain('2026-10-01');
    expect(text).toContain('14');
  });

  /**
   * §9.2 and `data/state-rules/KA.json`: a zero rate is not a rate. Karnataka
   * asserts none, and the honest page omits the interest line entirely rather
   * than printing a claim for zero rupees of interest.
   */
  it('omits the interest line when the state asserts no statutory rate', async () => {
    const { text } = await render();
    expect(text).not.toMatch(/interest of/i);
  });

  it('prints the interest line, and how it was computed, when a rate applies', async () => {
    const { text, bytes } = await render({
      claim: {
        ...model().claim,
        interest: {
          claimed: true,
          amount: p(50_630),
          principal: p(22_000_000),
          rateBps: 600,
          days: 14,
          fromDate: '2026-10-01',
          toDate: '2026-10-15',
          basis: 'SIMPLE_365',
        },
        totalClaimedPaise: p(22_050_630),
      },
    });

    expect(text).toContain('506.30'); // the interest itself
    expect(text).toContain('6.00%'); // the rate, from basis points
    expect(text).toContain('2,20,506.30'); // the new total
    expect(pdfProse(bytes)).toMatch(/simple interest on/i);
  });

  it('says so when the landlord claimed to withhold more than they hold', async () => {
    const { text } = await render({
      claim: { ...model().claim, claimedDeductionsPaise: p(30_000_000), deductionsExceedDeposit: true },
    });
    expect(text).toMatch(/exceed/i);
  });
});

describe('renderLetter — what it may and may not assert', () => {
  /** `demo-safety`: tamper-evidence, never admissibility. */
  it('never claims the record is admissible, proven or legally binding', async () => {
    const { prose } = await render();
    for (const forbidden of [/admissib/i, /legally binding/i, /\bproof of\b/i]) {
      expect(prose).not.toMatch(forbidden);
    }
  });

  /**
   * "Certified" may appear exactly once, inside the sentence that denies it.
   * Pinning the count rather than banning the word is the stronger assertion:
   * a blanket ban would also reject the disclaimer, and dropping the
   * disclaimer to satisfy it would be the actual failure.
   */
  it('claims certification nowhere except to deny it', async () => {
    const { prose } = await render();
    expect(prose.match(/certified/gi)).toHaveLength(1);
    expect(prose).toMatch(/not of authenticity independently certified by a third party/i);
  });

  it('states that it is not legal advice', async () => {
    const { prose } = await render();
    expect(prose).toMatch(/not legal advice/i);
  });

  it('reaches no verdict about responsibility or wear and tear', async () => {
    const { prose } = await render();
    expect(prose).not.toMatch(/\bat fault\b/i);
    expect(prose).not.toMatch(/\bresponsible for\b/i);
    expect(prose).toMatch(/reaches no conclusion about who caused any change/i);
  });

  /**
   * R9. `data/state-rules/KA.json` ships with no `lastReviewedAt`, and the
   * letter has to say so in its own words. A document that names a statute
   * while staying silent about whether anyone checked it is the failure the
   * absent field exists to prevent.
   */
  it('says the statutory references have not been reviewed when they have not', async () => {
    const { prose } = await render();
    expect(prose).toMatch(/have not been verified by a qualified person/i);
    expect(prose).not.toMatch(/last reviewed/i);
  });

  it('says when the rules were reviewed, once they have been', async () => {
    const { prose } = await render({
      rules: { ...model().rules, reviewed: true, lastReviewedAt: '2026-08-01' },
    });
    expect(prose).toMatch(/last reviewed on 2026-08-01/i);
    expect(prose).not.toMatch(/have not been verified/i);
  });

  it('carries the statutory citations from the reviewed table', async () => {
    const { text } = await render();
    expect(text).toContain('Karnataka Rent Act, 1999');
    expect(text).toContain('Court of Small Causes, Bengaluru');
  });

  it('prints the landlord’s stated reasons as their claim, not as findings', async () => {
    const { prose } = await render();
    expect(prose).toContain('Repainting the kitchen wall');
    expect(prose).toMatch(/reasons given by the landlord/i);
    expect(prose).toMatch(/the tenant does not accept them/i);
  });
});

describe('renderLetter — the evidence annexure', () => {
  it('lists each room with its photograph counts', async () => {
    const { text } = await render();
    expect(text).toContain('Kitchen');
  });

  it('prints the SHA-256 digest of every photograph it references', async () => {
    const { text } = await render();
    expect(text).toContain(`${'ab'.repeat(31)}cd`);
    expect(text).toContain(`${'ab'.repeat(31)}ef`);
  });

  it('prints the server timestamp each photograph was received at', async () => {
    const { text } = await render();
    expect(text).toContain('2025-04-01T10:00:00.000Z');
    expect(text).toContain('2026-09-01T10:00:00.000Z');
  });

  it('marks a change the tenant accepted from a suggestion as one', async () => {
    const { text } = await render();
    expect(text).toContain('A dark stain roughly 20cm across.');
    expect(text).toMatch(/suggestion.*accepted|accepted.*suggestion/i);
  });

  it('never prints a confidence figure', async () => {
    const { text } = await render();
    expect(text).not.toMatch(/confidence/i);
  });

  it('states plainly when a room carries no recorded changes', async () => {
    const { text } = await render({
      evidence: {
        rooms: [{ ...model().evidence.rooms[0]!, recordedChanges: [] }],
        totals: { roomCount: 1, photoCount: 2, recordedChangeCount: 0 },
      },
    });
    expect(text).toMatch(/no (recorded )?changes/i);
  });
});

describe('renderLetter — the artifact itself', () => {
  it('produces a PDF with the record reference on every page', async () => {
    const { bytes, text, ref, pageCount } = await render();

    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(pageCount).toBeGreaterThan(0);
    expect(text.split(ref).length - 1).toBe(pageCount);
  });

  it('uses the DL record-reference code', async () => {
    const { ref } = await render();
    expect(ref).toMatch(/^HND-DL-20261015-[0-9A-F]{8}$/);
  });

  /**
   * §5.6. The document hash is the ledger's handle on this artifact, so a
   * re-render of the same model has to produce the same bytes — otherwise
   * regenerating a letter would silently invalidate every reference to it.
   */
  it('is byte-for-byte deterministic', async () => {
    const a = await render();
    const b = await render();
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it('takes its metadata dates from the model rather than the clock', async () => {
    const { bytes } = await render();
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.getCreationDate()?.toISOString()).toBe(AT);
    expect(doc.getModificationDate()?.toISOString()).toBe(AT);
  });

  it('never puts an S3 key on the page — a key carries the tenancy id', async () => {
    const { text } = await render();
    expect(text).not.toContain('tenancies/t1');
  });

  it('survives a description containing characters WinAnsi cannot encode', async () => {
    const { text } = await render({
      evidence: {
        rooms: [
          {
            ...model().evidence.rooms[0]!,
            recordedChanges: [
              {
                ...model().evidence.rooms[0]!.recordedChanges[0]!,
                description: 'Stain — “about” 20cm … ಕನ್ನಡ',
              },
            ],
          },
        ],
        totals: { roomCount: 1, photoCount: 2, recordedChangeCount: 1 },
      },
    });
    expect(text).toContain('about');
  });
});
