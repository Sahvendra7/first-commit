/**
 * A generated JPEG pair for the end-to-end test.
 *
 * The golden-set photographs are gitignored — they are of a real home — so a
 * test that required them could not run on a clean clone or in CI. These are
 * structurally valid JPEGs carrying real EXIF (`DateTimeOriginal`,
 * `OffsetTimeOriginal`, GPS), which is all the capture path reads: it hashes
 * bytes and parses the APP1 segment, and never decodes pixels.
 *
 * Point `HANDOVER_E2E_PAIR_DIR` at a directory of real `before.jpg`/`after.jpg`
 * to run the same walk against actual photographs.
 */

type Entry = { tag: number; type: number; count: number; value: number[] };

const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
];
const ascii = (s: string): number[] => [...Buffer.from(`${s}\0`, 'latin1')];
const rational = (num: number, den: number): number[] => [...u32(num), ...u32(den)];

function ifd(entries: Entry[], baseOffset: number): number[] {
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
  dir.push(...u32(0));
  return [...dir, ...overflow];
}

export interface JpegOptions {
  readonly dateTimeOriginal: string;
  readonly offsetTimeOriginal?: string;
  /** Extra bytes of filler, so the two images of a pair differ in size. */
  readonly filler?: number;
}

/** A JPEG with a real EXIF APP1 segment and a stub image body. */
export function makeJpeg(opts: JpegOptions): Uint8Array {
  const HEADER = 8;

  const exifEntries: Entry[] = [
    {
      tag: 0x9003,
      type: 2,
      count: opts.dateTimeOriginal.length + 1,
      value: ascii(opts.dateTimeOriginal),
    },
  ];
  if (opts.offsetTimeOriginal) {
    exifEntries.push({
      tag: 0x9011,
      type: 2,
      count: opts.offsetTimeOriginal.length + 1,
      value: ascii(opts.offsetTimeOriginal),
    });
  }

  // 12°58'17.75"N, 77°35'40.44"E — Bengaluru, matching the seeded state rule.
  const gpsEntries: Entry[] = [
    { tag: 0x0001, type: 2, count: 2, value: ascii('N') },
    {
      tag: 0x0002,
      type: 5,
      count: 3,
      value: [...rational(12, 1), ...rational(58, 1), ...rational(1775, 100)],
    },
    { tag: 0x0003, type: 2, count: 2, value: ascii('E') },
    {
      tag: 0x0004,
      type: 5,
      count: 3,
      value: [...rational(77, 1), ...rational(35, 1), ...rational(4044, 100)],
    },
  ];

  const make: Entry = { tag: 0x010f, type: 2, count: 9, value: ascii('Handover') };

  const ifd0Count = 3; // make + two sub-IFD pointers
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const ifd0Overflow = make.value.length > 4 ? make.value.length : 0;
  const exifAt = HEADER + ifd0Size + ifd0Overflow;
  const exifBlock = ifd(exifEntries, exifAt);
  const gpsAt = exifAt + exifBlock.length;
  const gpsBlock = ifd(gpsEntries, gpsAt);

  const ifd0 = ifd(
    [
      make,
      { tag: 0x8769, type: 4, count: 1, value: u32(exifAt) },
      { tag: 0x8825, type: 4, count: 1, value: u32(gpsAt) },
    ],
    HEADER,
  );

  const tiff = [0x4d, 0x4d, ...u16(42), ...u32(HEADER), ...ifd0, ...exifBlock, ...gpsBlock];
  const payload = [...Buffer.from('Exif\0\0', 'latin1'), ...tiff];
  const segLen = payload.length + 2;

  const filler = Array.from({ length: opts.filler ?? 0 }, (_, i) => i % 251);

  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xe1, (segLen >> 8) & 0xff, segLen & 0xff, ...payload,
    0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, // stub DQT
    0xff, 0xfe, ((filler.length + 2) >> 8) & 0xff, (filler.length + 2) & 0xff, ...filler, // COM
    0xff, 0xd9, // EOI
  ]);
}

/** A move-in / move-out pair with distinct capture times and distinct bytes. */
export function makeJpegPair(): { before: Uint8Array; after: Uint8Array } {
  return {
    before: makeJpeg({
      dateTimeOriginal: '2026:01:15 10:22:41',
      offsetTimeOriginal: '+05:30',
      filler: 512,
    }),
    after: makeJpeg({
      dateTimeOriginal: '2026:09:18 16:05:12',
      offsetTimeOriginal: '+05:30',
      filler: 1024,
    }),
  };
}
