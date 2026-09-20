/**
 * `stripJpegMetadata` — architecture.md §5.4, §10.1; `demo-safety`.
 *
 * The rule has two halves and both are load-bearing:
 *
 *   **Strip EXIF (including GPS) from images embedded in outbound PDFs.
 *    Never from the stored original.**
 *
 * The original stays byte-identical to what its SHA-256 attests, or the hash
 * attests to nothing. The derivative goes to a landlord, and a home's GPS
 * coordinates travelling to the other party in a deposit dispute is a real
 * harm — the tenant may well have moved out precisely to get away from them.
 *
 * So these tests assert both directions: the metadata is gone, and the input
 * buffer is untouched.
 */
import { describe, expect, it } from 'vitest';
import { extractExif } from '../../../src/domain/evidence/exif.js';
import { stripJpegMetadata } from '../../../src/domain/evidence/strip-metadata.js';

/** Build a JPEG carrying the given APP segments, then a minimal scan. */
function jpeg(segments: Array<{ marker: number; payload: number[] }>): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  for (const { marker, payload } of segments) {
    const length = payload.length + 2;
    out.push(0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload);
  }
  // A quantisation table (kept), then start-of-scan and end-of-image.
  out.push(0xff, 0xdb, 0x00, 0x04, 0x00, 0x00);
  out.push(0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0x33);
  out.push(0xff, 0xd9);
  return new Uint8Array(out);
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** A real-shaped EXIF APP1 payload with a GPS IFD and a capture time. */
function exifPayload(): number[] {
  // "Exif\0\0" then a little-endian TIFF header with one IFD entry.
  const tiff = [
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // II*, IFD0 at 8
    0x01, 0x00, // one entry
    0x03, 0x01, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00, // tag 0x0103, ASCII, 4
    0x1a, 0x00, 0x00, 0x00, // value offset
    0x00, 0x00, 0x00, 0x00, // next IFD = 0
    ...ascii('abc\0'),
  ];
  return [...ascii('Exif'), 0x00, 0x00, ...tiff];
}

describe('stripJpegMetadata — what must be gone', () => {
  it('removes an APP1 EXIF segment', () => {
    const withExif = jpeg([{ marker: 0xe1, payload: exifPayload() }]);
    const stripped = stripJpegMetadata(withExif);

    expect(stripped.byteLength).toBeLessThan(withExif.byteLength);
    expect(Buffer.from(stripped).includes(Buffer.from('Exif'))).toBe(false);
  });

  it('removes GPS coordinates with it — the whole point of the rule', () => {
    const gps = ascii('GPSLatitude 12.9716 GPSLongitude 77.5946');
    const withGps = jpeg([{ marker: 0xe1, payload: [...exifPayload(), ...gps] }]);

    const stripped = Buffer.from(stripJpegMetadata(withGps));

    expect(stripped.includes(Buffer.from('GPSLatitude'))).toBe(false);
    expect(stripped.includes(Buffer.from('77.5946'))).toBe(false);
  });

  it('leaves nothing the EXIF parser can still read', () => {
    // The strongest form of the assertion: not "the bytes changed" but "the
    // code that reads this metadata now finds none".
    const withExif = jpeg([{ marker: 0xe1, payload: exifPayload() }]);

    expect(extractExif(stripJpegMetadata(withExif))).toEqual({});
  });

  it('removes XMP, which also carries location and device metadata', () => {
    const xmp = ascii('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>12.97,77.59</x:xmpmeta>');
    const stripped = Buffer.from(stripJpegMetadata(jpeg([{ marker: 0xe1, payload: xmp }])));

    expect(stripped.includes(Buffer.from('xmpmeta'))).toBe(false);
  });

  it('removes a comment segment', () => {
    const stripped = Buffer.from(
      stripJpegMetadata(jpeg([{ marker: 0xfe, payload: ascii('shot at home') }])),
    );

    expect(stripped.includes(Buffer.from('shot at home'))).toBe(false);
  });

  it('removes every APPn segment, not only the first', () => {
    const stripped = Buffer.from(
      stripJpegMetadata(
        jpeg([
          { marker: 0xe1, payload: exifPayload() },
          { marker: 0xe2, payload: ascii('ICC_PROFILE-ish') },
          { marker: 0xed, payload: ascii('Photoshop IRB') },
        ]),
      ),
    );

    expect(stripped.includes(Buffer.from('Exif'))).toBe(false);
    expect(stripped.includes(Buffer.from('ICC_PROFILE-ish'))).toBe(false);
    expect(stripped.includes(Buffer.from('Photoshop IRB'))).toBe(false);
  });
});

describe('stripJpegMetadata — what must remain', () => {
  it('keeps the JPEG a JPEG', () => {
    const stripped = stripJpegMetadata(jpeg([{ marker: 0xe1, payload: exifPayload() }]));

    expect(stripped[0]).toBe(0xff);
    expect(stripped[1]).toBe(0xd8);
    expect(stripped[stripped.length - 2]).toBe(0xff);
    expect(stripped[stripped.length - 1]).toBe(0xd9);
  });

  it('keeps the image data — the picture still has to be the picture', () => {
    const stripped = Buffer.from(stripJpegMetadata(jpeg([{ marker: 0xe1, payload: exifPayload() }])));

    // The quantisation table and the scan survive.
    expect(stripped.includes(Buffer.from([0xff, 0xdb]))).toBe(true);
    expect(stripped.includes(Buffer.from([0xff, 0xda]))).toBe(true);
    expect(stripped.includes(Buffer.from([0x11, 0x22, 0x33]))).toBe(true);
  });

  it('is a no-op on a JPEG that carries no metadata', () => {
    const plain = jpeg([]);
    expect(Array.from(stripJpegMetadata(plain))).toEqual(Array.from(plain));
  });
});

describe('stripJpegMetadata — the stored original is never touched', () => {
  it('does not mutate the input buffer', () => {
    const original = jpeg([{ marker: 0xe1, payload: exifPayload() }]);
    const before = Array.from(original);

    stripJpegMetadata(original);

    expect(Array.from(original)).toEqual(before);
  });

  it('returns a different buffer, never the same one', () => {
    const original = jpeg([{ marker: 0xe1, payload: exifPayload() }]);
    expect(stripJpegMetadata(original)).not.toBe(original);
  });
});

describe('stripJpegMetadata — hostile and malformed input', () => {
  /**
   * This runs on bytes a stranger uploaded. It is called inside a worker, so
   * a throw or a loop is an outage; every one of these must return something.
   */
  it('returns non-JPEG input unchanged rather than corrupting it', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    expect(Array.from(stripJpegMetadata(png))).toEqual(Array.from(png));
  });

  it('survives an empty buffer', () => {
    expect(stripJpegMetadata(new Uint8Array()).byteLength).toBe(0);
  });

  it('survives a truncated JPEG', () => {
    expect(() => stripJpegMetadata(new Uint8Array([0xff, 0xd8, 0xff]))).not.toThrow();
  });

  it('survives a segment whose declared length runs past the buffer', () => {
    const lying = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x01, 0x02]);
    expect(() => stripJpegMetadata(lying)).not.toThrow();
  });

  it('survives a segment declaring an impossible length', () => {
    const zero = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x00, 0xff, 0xd9]);
    expect(() => stripJpegMetadata(zero)).not.toThrow();
  });

  it('is deterministic', () => {
    const input = jpeg([{ marker: 0xe1, payload: exifPayload() }]);
    expect(Array.from(stripJpegMetadata(input))).toEqual(Array.from(stripJpegMetadata(input)));
  });
});
