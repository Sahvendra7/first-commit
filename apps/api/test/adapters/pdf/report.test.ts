import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { pdfText } from '../../support/pdf-text.js';
import { renderReport } from '../../../src/adapters/pdf/report.js';
import { recordRefFor } from '../../../src/domain/documents/report-model.js';
import type { ReportModel } from '../../../src/domain/documents/report-model.js';

/**
 * The rendered PDF — architecture.md §5.6; `demo-safety`.
 *
 * Assertions are made against the *produced bytes*, not against the renderer's
 * inputs. A test that checks the model would pass while the template said
 * something else entirely, and the template is where the copy rules either
 * hold or fail.
 */

const AT = '2026-09-20T12:00:00.000Z';

const photo = (phase: 'MOVEIN' | 'MOVEOUT', n: number) => ({
  photoId: `p_${phase}_${n}`,
  phase,
  pairIndex: n,
  sha256: `${'ab'.repeat(31)}${phase === 'MOVEIN' ? 'cd' : 'ef'}`,
  bytes: 240_000,
  receivedAt: phase === 'MOVEIN' ? '2026-01-15T10:00:00.000Z' : '2026-09-19T10:00:00.000Z',
  s3Key: `tenancies/t1/${phase}/r1/${n}.jpg`,
});

const model = (over: Partial<ReportModel> = {}): ReportModel => ({
  docType: 'EXIT_REPORT',
  phase: 'MOVEOUT',
  tenancy: {
    tenancyId: 't1',
    addressLine: '12 MG Road',
    city: 'Bengaluru',
    stateCode: 'KA',
    moveInDate: '2026-01-15',
  },
  rooms: [
    {
      roomId: 'r1',
      label: 'Kitchen',
      orderIndex: 0,
      movein: [photo('MOVEIN', 0)],
      moveout: [photo('MOVEOUT', 0)],
      recordedChanges: [
        {
          id: 'c1',
          type: 'STAIN',
          surface: 'WALL',
          location: 'wall left of the window',
          description: 'A dark stain roughly 20cm across.',
          origin: 'TENANT_RECORDED',
        },
      ],
    },
  ],
  generatedAt: AT,
  totals: { roomCount: 1, photoCount: 2, recordedChangeCount: 1 },
  ...over,
});

/** Read what the PDF actually draws — see `pdfText` for why inflation matters. */
const textOf = async (bytes: Uint8Array): Promise<string> => pdfText(bytes);

const REF = recordRefFor('t1', 'EXIT_REPORT', AT);

describe('renderReport — it is a real PDF', () => {
  it('produces a loadable document', async () => {
    const { bytes, pageCount } = await renderReport(model(), REF);

    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe('%PDF-');
    expect(pageCount).toBeGreaterThanOrEqual(1);
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
  });

  it('is deterministic — the same model renders to the same bytes', async () => {
    // §5.6 calls the assembly deterministic, and the document hash printed in
    // the ledger depends on it. A PDF that differed per render would make the
    // stored digest meaningless.
    const a = await renderReport(model(), REF);
    const b = await renderReport(model(), REF);

    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it('puts the record reference in the footer of every page', async () => {
    const { bytes, pageCount } = await renderReport(model(), REF);
    const text = await textOf(bytes);

    const footers = [...text.matchAll(new RegExp(REF, 'g'))];
    expect(footers).toHaveLength(pageCount);
    expect(text).toContain('page 1 of');
  });
});

describe('renderReport — the evidence is on the page', () => {
  it('prints each photograph’s SHA-256 in full', async () => {
    const text = await textOf((await renderReport(model(), REF)).bytes);

    expect(text).toContain(`${'ab'.repeat(31)}cd`);
    expect(text).toContain(`${'ab'.repeat(31)}ef`);
  });

  it('prints the server timestamp, and says it is the server’s', async () => {
    const text = await textOf((await renderReport(model(), REF)).bytes);

    expect(text).toContain('2026-01-15T10:00:00.000Z');
    expect(text).toContain('server clock');
  });

  it('marks a camera-reported time as not independently verified', async () => {
    const withExif = model({
      rooms: [
        {
          ...model().rooms[0]!,
          movein: [{ ...photo('MOVEIN', 0), exifCapturedAt: '2026-01-15T09:58:12.000Z' }],
        },
      ],
    });
    const text = await textOf((await renderReport(withExif, REF)).bytes);

    expect(text).toContain('Camera reported');
    expect(text).toContain('not independently verified');
  });

  it('states when a room has no photographs rather than omitting the room', async () => {
    const empty = model({
      rooms: [{ roomId: 'r2', label: 'Balcony', orderIndex: 1, movein: [], moveout: [], recordedChanges: [] }],
    });
    const text = await textOf((await renderReport(empty, REF)).bytes);

    expect(text).toContain('Balcony');
    expect(text).toContain('No photographs were recorded');
  });
});

describe('renderReport — the copy rules (demo-safety)', () => {
  it('claims tamper-evidence and never admissibility', async () => {
    const text = (await textOf((await renderReport(model(), REF)).bytes)).toLowerCase();

    expect(text).toContain('unchanged since capture');
    for (const forbidden of ['admissible', 'admissibility', 'court will accept', 'legally binding', 'proof of']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('says plainly that the digests are its own', async () => {
    // The caveat that weakens the document, kept because a reader who finds
    // it out later has been misled by its absence.
    const text = (await textOf((await renderReport(model(), REF)).bytes)).toLowerCase();

    expect(text).toContain('generated by this service');
    expect(text).toContain('not of');
  });

  it('reaches no conclusion about responsibility', async () => {
    const text = (await textOf((await renderReport(model(), REF)).bytes)).toLowerCase();

    // The disclaimer must be present *and* must be the only place the phrase
    // "normal wear and tear" appears — the document may say it reaches no
    // conclusion about wear and tear, and may never reach one.
    expect(text).toContain('reaches no conclusion about');
    expect(text).toContain('whether any change is normal wear and tear');

    for (const verdict of [
      'this is normal wear',
      'this is tenant damage',
      'tenant damage',
      'the tenant is liable',
      'the landlord is liable',
      'caused by the tenant',
      'at fault',
    ]) {
      expect(text).not.toContain(verdict);
    }
  });

  it('labels a tenant-recorded change as the tenant’s', async () => {
    const text = await textOf((await renderReport(model(), REF)).bytes);
    expect(text).toContain('Recorded by the tenant');
  });

  it('labels an accepted suggestion as software-derived — the §9.7 marker', async () => {
    const suggested = model({
      rooms: [
        {
          ...model().rooms[0]!,
          recordedChanges: [
            { ...model().rooms[0]!.recordedChanges[0]!, origin: 'TENANT_ACCEPTED_SUGGESTION' },
          ],
        },
      ],
    });
    const text = await textOf((await renderReport(suggested, REF)).bytes);

    expect(text).toContain('Software suggestion');
    expect(text).toContain('accepted by the tenant');
  });

  it('renders wear-and-tear as two opposed arguments, never a verdict', async () => {
    const framed = model({
      rooms: [
        {
          ...model().rooms[0]!,
          recordedChanges: [
            {
              ...model().rooms[0]!.recordedChanges[0]!,
              wearAndTear: {
                landlordMayArgue: 'This is new damage from a spill.',
                tenantsTypicallyCounter: 'Floor staining accrues with ordinary use.',
              },
            },
          ],
        },
      ],
    });
    const text = await textOf((await renderReport(framed, REF)).bytes);

    expect(text).toContain('A landlord may argue:');
    expect(text).toContain('Tenants typically counter:');
    expect(text).toContain('This is new damage from a spill.');
  });

  it('never prints a model confidence number', async () => {
    const text = await textOf((await renderReport(model(), REF)).bytes);
    expect(text).not.toMatch(/confiden/i);
  });
});

describe('renderReport — a Condition Report is the move-in record alone', () => {
  const movein = model({
    docType: 'CONDITION_REPORT',
    phase: 'MOVEIN',
    rooms: [
      {
        roomId: 'r1',
        label: 'Kitchen',
        orderIndex: 0,
        movein: [photo('MOVEIN', 0)],
        moveout: [],
        recordedChanges: [],
      },
    ],
    totals: { roomCount: 1, photoCount: 1, recordedChangeCount: 0 },
  });

  it('uses the Condition Report title', async () => {
    const text = await textOf((await renderReport(movein, recordRefFor('t1', 'CONDITION_REPORT', AT))).bytes);
    expect(text).toContain('Property Condition Report');
    expect(text).not.toContain('Property Exit Report');
  });

  it('shows no move-out section and no change section', async () => {
    const text = await textOf((await renderReport(movein, REF)).bytes);

    expect(text).toContain('At move-in');
    expect(text).not.toContain('At move-out');
    expect(text).not.toContain('Recorded changes');
  });
});

describe('renderReport — embedded photographs', () => {
  /** A 1x1 JPEG with an APP1 EXIF segment carrying a GPS-looking string. */
  const jpegWithExif = (): Uint8Array => {
    const exif = [...'Exif'].map((c) => c.charCodeAt(0));
    const gps = [...'GPS 12.9716,77.5946'].map((c) => c.charCodeAt(0));
    const payload = [...exif, 0x00, 0x00, ...gps];
    const base = Buffer.from(
      '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
        'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
        'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
      'base64',
    );
    // Splice the APP1 segment in right after SOI.
    const length = payload.length + 2;
    return new Uint8Array([
      0xff, 0xd8,
      0xff, 0xe1, (length >> 8) & 0xff, length & 0xff, ...payload,
      ...base.subarray(2),
    ]);
  };

  it('embeds a photograph when its bytes are supplied', async () => {
    const withImage = await renderReport(model(), REF, new Map([['tenancies/t1/MOVEIN/r1/0.jpg', jpegWithExif()]]));
    const withoutImage = await renderReport(model(), REF);

    expect(withImage.bytes.byteLength).toBeGreaterThan(withoutImage.bytes.byteLength);
  });

  it('strips EXIF and GPS from the embedded derivative', async () => {
    // The harm this prevents: the document goes to the landlord, and a phone
    // photograph of a home carries its coordinates.
    const { bytes } = await renderReport(
      model(),
      REF,
      new Map([['tenancies/t1/MOVEIN/r1/0.jpg', jpegWithExif()]]),
    );
    const raw = Buffer.from(bytes);

    expect(raw.includes(Buffer.from('77.5946'))).toBe(false);
    expect(raw.includes(Buffer.from('GPS 12.9716'))).toBe(false);
  });

  it('still prints the record when a photograph is not attached', async () => {
    const text = await textOf((await renderReport(model(), REF)).bytes);

    expect(text).toContain('photograph not attached');
    expect(text).toContain(`${'ab'.repeat(31)}cd`);
  });

  it('still prints the record when a photograph cannot be decoded', async () => {
    const garbage = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]);
    const text = await textOf(
      (await renderReport(model(), REF, new Map([['tenancies/t1/MOVEIN/r1/0.jpg', garbage]]))).bytes,
    );

    expect(text).toContain('could not be rendered');
    expect(text).toContain(`${'ab'.repeat(31)}cd`);
  });
});

describe('renderReport — hostile text', () => {
  it('does not fail the document over characters the font cannot encode', async () => {
    const exotic = model({
      rooms: [
        {
          ...model().rooms[0]!,
          label: 'Kitchen — “main” • कोठी',
          recordedChanges: [
            {
              ...model().rooms[0]!.recordedChanges[0]!,
              description: 'A stain – roughly 20cm … near the “window” ☃',
            },
          ],
        },
      ],
    });

    await expect(renderReport(exotic, REF)).resolves.toBeDefined();
    const text = await textOf((await renderReport(exotic, REF)).bytes);
    expect(text).toContain('"main"');
  });
});
