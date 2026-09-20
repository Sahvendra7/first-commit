import { describe, expect, it } from 'vitest';
import { extractExif } from '../../../src/domain/evidence/exif.js';

/**
 * EXIF extraction — architecture.md §5.4.
 *
 * §5.4's "critical correction to a common assumption" is that EXIF is *not*
 * stripped from the stored original: it is corroborating evidence, and the
 * object must stay byte-identical to what its SHA-256 attests. So this module
 * only ever reads. Stripping happens later, on the derivative image embedded
 * into an outbound PDF, which is the only place a third party sees it.
 *
 * The fixtures are built byte by byte rather than checked in. The golden-set
 * photographs are gitignored (they are of a real home), so a test that needed a
 * real JPEG could not run on a clean clone — and a hand-built segment lets each
 * test state exactly which malformation it is about.
 */

/* ── A minimal JPEG/EXIF builder ───────────────────────────────────────────── */

type Entry = { tag: number; type: number; count: number; value: number[] };
type Order = 'MM' | 'II';

/**
 * The builder emits whichever byte order the test asked for. Most real cameras
 * write little-endian ("II"), so a suite that only ever built big-endian files
 * would leave the common path untested.
 */
let ORDER: Order = 'MM';

const u16 = (n: number): number[] => {
  const be = [(n >> 8) & 0xff, n & 0xff];
  return ORDER === 'MM' ? be : be.reverse();
};
const u32 = (n: number): number[] => {
  const be = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return ORDER === 'MM' ? be : be.reverse();
};

const ascii = (s: string): number[] => [...Buffer.from(`${s}\0`, 'latin1')];

/** Build one IFD plus its overflow area at a known TIFF offset. */
function ifd(entries: Entry[], baseOffset: number, nextIfd = 0): number[] {
  const dirSize = 2 + entries.length * 12 + 4;
  let overflowAt = baseOffset + dirSize;
  const overflow: number[] = [];
  const dir: number[] = [...u16(entries.length)];

  for (const e of entries) {
    dir.push(...u16(e.tag), ...u16(e.type), ...u32(e.count));
    if (e.value.length <= 4) {
      dir.push(...e.value, ...new Array(4 - e.value.length).fill(0));
    } else {
      dir.push(...u32(overflowAt));
      overflow.push(...e.value);
      overflowAt += e.value.length;
    }
  }
  dir.push(...u32(nextIfd));
  return [...dir, ...overflow];
}

const rational = (num: number, den: number): number[] => [...u32(num), ...u32(den)];

interface BuildOptions {
  dateTimeOriginal?: string;
  offsetTimeOriginal?: string;
  gps?: { latRef: string; lat: [number, number, number]; lonRef: string; lon: [number, number, number] };
  make?: string;
  byteOrder?: 'MM' | 'II';
}

/**
 * Produce a JPEG whose APP1 segment carries the requested EXIF. The image body
 * is a stub — nothing here decodes pixels.
 */
function jpegWithExif(opts: BuildOptions = {}): Uint8Array {
  ORDER = opts.byteOrder ?? 'MM';
  const tiff: number[] = [];
  const HEADER = 8;

  // IFD0 sits right after the TIFF header; sub-IFDs follow it.
  const ifd0Entries: Entry[] = [];
  if (opts.make) ifd0Entries.push({ tag: 0x010f, type: 2, count: opts.make.length + 1, value: ascii(opts.make) });

  const exifEntries: Entry[] = [];
  if (opts.dateTimeOriginal) {
    exifEntries.push({
      tag: 0x9003,
      type: 2,
      count: opts.dateTimeOriginal.length + 1,
      value: ascii(opts.dateTimeOriginal),
    });
  }
  if (opts.offsetTimeOriginal) {
    exifEntries.push({
      tag: 0x9011,
      type: 2,
      count: opts.offsetTimeOriginal.length + 1,
      value: ascii(opts.offsetTimeOriginal),
    });
  }

  const gpsEntries: Entry[] = [];
  if (opts.gps) {
    gpsEntries.push({ tag: 0x0001, type: 2, count: 2, value: ascii(opts.gps.latRef) });
    gpsEntries.push({
      tag: 0x0002,
      type: 5,
      count: 3,
      value: [
        ...rational(opts.gps.lat[0], 1),
        ...rational(opts.gps.lat[1], 1),
        ...rational(Math.round(opts.gps.lat[2] * 100), 100),
      ],
    });
    gpsEntries.push({ tag: 0x0003, type: 2, count: 2, value: ascii(opts.gps.lonRef) });
    gpsEntries.push({
      tag: 0x0004,
      type: 5,
      count: 3,
      value: [
        ...rational(opts.gps.lon[0], 1),
        ...rational(opts.gps.lon[1], 1),
        ...rational(Math.round(opts.gps.lon[2] * 100), 100),
      ],
    });
  }

  // Lay out: IFD0 (with pointers) → EXIF IFD → GPS IFD.
  const ifd0Size = 2 + (ifd0Entries.length + (exifEntries.length ? 1 : 0) + (gpsEntries.length ? 1 : 0)) * 12 + 4;
  const ifd0Overflow = ifd0Entries.reduce((n, e) => n + (e.value.length > 4 ? e.value.length : 0), 0);
  const exifAt = HEADER + ifd0Size + ifd0Overflow;
  const exifBlock = exifEntries.length ? ifd(exifEntries, exifAt) : [];
  const gpsAt = exifAt + exifBlock.length;
  const gpsBlock = gpsEntries.length ? ifd(gpsEntries, gpsAt) : [];

  const withPointers = [...ifd0Entries];
  if (exifEntries.length) withPointers.push({ tag: 0x8769, type: 4, count: 1, value: u32(exifAt) });
  if (gpsEntries.length) withPointers.push({ tag: 0x8825, type: 4, count: 1, value: u32(gpsAt) });

  tiff.push(...(ORDER === 'MM' ? [0x4d, 0x4d] : [0x49, 0x49]));
  tiff.push(...u16(42), ...u32(HEADER));
  tiff.push(...ifd(withPointers, HEADER), ...exifBlock, ...gpsBlock);

  const app1Payload = [...Buffer.from('Exif\0\0', 'latin1'), ...tiff];
  // JPEG segment lengths are big-endian always — the TIFF byte order inside the
  // APP1 payload does not reach out and change the container's framing.
  const segLen = app1Payload.length + 2;
  const app1 = [0xff, 0xe1, (segLen >> 8) & 0xff, segLen & 0xff, ...app1Payload];

  return new Uint8Array([
    0xff, 0xd8, // SOI
    ...app1,
    0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, // a stub DQT (big-endian length)
    0xff, 0xd9, // EOI
  ]);
}

/* ── Tests ─────────────────────────────────────────────────────────────────── */

describe('extractExif — capture time', () => {
  it('reads DateTimeOriginal and normalises it to ISO-8601', () => {
    const exif = extractExif(jpegWithExif({ dateTimeOriginal: '2026:09:19 14:32:07' }));
    expect(exif.capturedAt).toBe('2026-09-19T14:32:07Z');
  });

  it('applies OffsetTimeOriginal when the camera recorded one', () => {
    const exif = extractExif(
      jpegWithExif({ dateTimeOriginal: '2026:09:19 14:32:07', offsetTimeOriginal: '+05:30' }),
    );
    expect(exif.capturedAt).toBe('2026-09-19T14:32:07+05:30');
  });

  it('omits the capture time when the tag is absent', () => {
    expect(extractExif(jpegWithExif({ make: 'Handover' })).capturedAt).toBeUndefined();
  });

  it('omits an unparseable capture time rather than guessing', () => {
    expect(extractExif(jpegWithExif({ dateTimeOriginal: 'not a date' })).capturedAt).toBeUndefined();
  });

  it('omits the EXIF zero-date that cameras write for "unset"', () => {
    expect(
      extractExif(jpegWithExif({ dateTimeOriginal: '0000:00:00 00:00:00' })).capturedAt,
    ).toBeUndefined();
  });
});

describe('extractExif — GPS', () => {
  it('converts degrees/minutes/seconds to a signed decimal pair', () => {
    const exif = extractExif(
      jpegWithExif({
        gps: { latRef: 'N', lat: [12, 58, 17.75], lonRef: 'E', lon: [77, 35, 40.44] },
      }),
    );
    expect(exif.gps).toBe('12.971597,77.594567');
  });

  it('negates the southern and western hemispheres', () => {
    const exif = extractExif(
      jpegWithExif({
        gps: { latRef: 'S', lat: [33, 51, 54.0], lonRef: 'W', lon: [70, 39, 0.0] },
      }),
    );
    expect(exif.gps?.startsWith('-33.')).toBe(true);
    expect(exif.gps?.includes(',-70.')).toBe(true);
  });

  it('omits GPS when the photo carries none', () => {
    expect(extractExif(jpegWithExif({ dateTimeOriginal: '2026:09:19 14:32:07' })).gps).toBeUndefined();
  });
});

describe('extractExif — byte order', () => {
  it('reads big-endian ("MM") files', () => {
    const exif = extractExif(
      jpegWithExif({ dateTimeOriginal: '2026:09:19 14:32:07', byteOrder: 'MM' }),
    );
    expect(exif.capturedAt).toBe('2026-09-19T14:32:07Z');
  });

  /** The common case: most cameras and phones write little-endian TIFF. */
  it('reads little-endian ("II") files', () => {
    const exif = extractExif(
      jpegWithExif({ dateTimeOriginal: '2026:09:19 14:32:07', byteOrder: 'II' }),
    );
    expect(exif.capturedAt).toBe('2026-09-19T14:32:07Z');
  });

  it('reads GPS from a little-endian file', () => {
    const exif = extractExif(
      jpegWithExif({
        byteOrder: 'II',
        gps: { latRef: 'N', lat: [12, 58, 17.75], lonRef: 'E', lon: [77, 35, 40.44] },
      }),
    );
    expect(exif.gps).toBe('12.971597,77.594567');
  });
});

describe('extractExif — hostile and malformed input', () => {
  /**
   * Every one of these must return an empty result rather than throw. This
   * parser runs inside `photo-ingest`, and a throw there fails the invocation,
   * burns both retries and parks a perfectly good photograph in the DLQ. A
   * photo with unreadable EXIF is still evidence: it still has a hash and a
   * server-clock `receivedAt`, which are the fields the record actually rests on.
   */
  it.each([
    ['empty input', new Uint8Array(0)],
    ['not a JPEG', new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
    ['SOI with no segments', new Uint8Array([0xff, 0xd8, 0xff, 0xd9])],
    ['truncated mid-APP1', new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x40, 0x45, 0x78])],
    ['APP1 that is not EXIF', new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x58, 0x4d, 0x50, 0x00, 0x00, 0x00])],
    ['a bad TIFF magic', new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2b, 0x00, 0x00, 0x00, 0x08])],
  ])('returns an empty result for %s', (_why, bytes) => {
    expect(() => extractExif(bytes)).not.toThrow();
    expect(extractExif(bytes)).toEqual({});
  });

  it('survives an IFD offset pointing past the end of the buffer', () => {
    const bytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
      0x4d, 0x4d, 0x00, 0x2a, 0xff, 0xff, 0xff, 0xf0,
    ]);
    expect(extractExif(bytes)).toEqual({});
  });

  it('does not hang on an IFD whose next-pointer loops back on itself', () => {
    // Big-endian TIFF, IFD0 at 8, zero entries, next-IFD pointing at itself.
    const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08];
    const payload = [...Buffer.from('Exif\0\0', 'latin1'), ...tiff];
    const bytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload,
    ]);
    expect(extractExif(bytes)).toEqual({});
  });
});
