/**
 * EXIF extraction — architecture.md §5.4.
 *
 * Reads capture time and GPS out of a JPEG's APP1 segment. It never writes:
 * §5.4's "critical correction to a common assumption" is that EXIF stays in the
 * stored original, because the object must remain byte-identical to what its
 * SHA-256 attests, and because EXIF is itself corroborating evidence. Stripping
 * belongs on the derivative image embedded into an outbound PDF (§10.1), which
 * is the only place a third party ever sees the bytes.
 *
 * Hand-rolled rather than a dependency, for two reasons that matter here: the
 * EXIF libraries on npm are large, and this reads exactly four tags out of a
 * structure that is fully specified. Everything below is bounds-checked and
 * total — the contract is that it *never throws and never loops*, because it
 * runs inside `photo-ingest`, where a throw costs two Lambda retries and parks
 * a good photograph in the DLQ.
 *
 * What the model owns and what code owns (§9.2) applies here too: these fields
 * are read by code from the file, never described by a model. They are also not
 * authoritative — `receivedAt`, from the server clock, is the timestamp the
 * evidence record actually attests to. EXIF corroborates it.
 */

/** Everything this parser will extract. Every field is optional by nature. */
export interface ExtractedExif {
  /**
   * ISO-8601. Carries a real offset when the camera recorded
   * `OffsetTimeOriginal`; otherwise the naive EXIF wall-clock time is
   * normalised with a `Z`.
   *
   * That `Z` is a formatting decision, not a claim about the photographer's
   * timezone — most cameras and many phones write no offset at all, and
   * dropping the field entirely would throw away corroborating evidence to
   * avoid a discrepancy that the record does not rest on. Anything that
   * displays this must label it as the camera's reported time.
   */
  readonly capturedAt?: string;
  /** `"<lat>,<lon>"` in signed decimal degrees. */
  readonly gps?: string;
}

const EMPTY: ExtractedExif = {};

/* ── TIFF primitives ───────────────────────────────────────────────────────── */

const TYPE_SIZES: Readonly<Record<number, number>> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  7: 1, // UNDEFINED
  9: 4, // SLONG
  10: 8, // SRATIONAL
};

const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;
const TAG_DATETIME_DIGITIZED = 0x9004;
const TAG_GPS_LAT_REF = 0x0001;
const TAG_GPS_LAT = 0x0002;
const TAG_GPS_LON_REF = 0x0003;
const TAG_GPS_LON = 0x0004;

/** A bounds-checked cursor over the TIFF block. Returns undefined, never throws. */
class TiffReader {
  private readonly view: DataView;
  readonly littleEndian: boolean;

  constructor(
    private readonly bytes: Uint8Array,
    littleEndian: boolean,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.littleEndian = littleEndian;
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  u16(offset: number): number | undefined {
    if (offset < 0 || offset + 2 > this.length) return undefined;
    return this.view.getUint16(offset, this.littleEndian);
  }

  u32(offset: number): number | undefined {
    if (offset < 0 || offset + 4 > this.length) return undefined;
    return this.view.getUint32(offset, this.littleEndian);
  }

  ascii(offset: number, count: number): string | undefined {
    if (offset < 0 || count < 0 || offset + count > this.length) return undefined;
    let out = '';
    for (let i = 0; i < count; i += 1) {
      const c = this.bytes[offset + i]!;
      if (c === 0) break;
      out += String.fromCharCode(c);
    }
    return out;
  }

  /** One RATIONAL as a number. Guards the zero denominator. */
  rational(offset: number): number | undefined {
    const num = this.u32(offset);
    const den = this.u32(offset + 4);
    if (num === undefined || den === undefined || den === 0) return undefined;
    return num / den;
  }
}

interface IfdEntry {
  readonly type: number;
  readonly count: number;
  /** Where the value bytes actually live, inline field or overflow area. */
  readonly valueOffset: number;
}

/**
 * Read one IFD into a tag → entry map.
 *
 * `seen` breaks pointer cycles: a crafted file can point an IFD at itself, and
 * an unguarded walk would spin until the Lambda times out.
 */
function readIfd(r: TiffReader, offset: number, seen: Set<number>): Map<number, IfdEntry> {
  const out = new Map<number, IfdEntry>();
  if (offset <= 0 || offset >= r.length || seen.has(offset)) return out;
  seen.add(offset);

  const count = r.u16(offset);
  if (count === undefined || count === 0 || count > 512) return out;

  for (let i = 0; i < count; i += 1) {
    const at = offset + 2 + i * 12;
    const tag = r.u16(at);
    const type = r.u16(at + 2);
    const n = r.u32(at + 4);
    if (tag === undefined || type === undefined || n === undefined) break;

    const size = TYPE_SIZES[type];
    if (size === undefined) continue;

    const total = size * n;
    if (!Number.isFinite(total) || total < 0 || total > r.length) continue;

    let valueOffset = at + 8;
    if (total > 4) {
      const pointer = r.u32(at + 8);
      if (pointer === undefined || pointer + total > r.length) continue;
      valueOffset = pointer;
    }
    out.set(tag, { type, count: n, valueOffset });
  }
  return out;
}

/* ── Field decoding ────────────────────────────────────────────────────────── */

/** `YYYY:MM:DD HH:MM:SS` → ISO-8601, or undefined if it is not that shape. */
function toIso(raw: string | undefined, offset: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m) return undefined;

  const [, year, month, day, hour, minute, second] = m as unknown as string[];
  // Cameras write an all-zero date to mean "unset". Storing it would put the
  // year 0 next to a real server timestamp in the Condition Report.
  if (year === '0000' || month === '00' || day === '00') return undefined;

  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  const s = Number(second);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return undefined;
  // Reject a day that does not exist in that month (2026-02-30 and friends).
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return undefined;

  const suffix = offset && /^[+-]\d{2}:\d{2}$/.test(offset.trim()) ? offset.trim() : 'Z';
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${suffix}`;
}

/** Three RATIONALs (degrees, minutes, seconds) plus a hemisphere ref. */
function toDecimalDegrees(
  r: TiffReader,
  entry: IfdEntry | undefined,
  ref: string | undefined,
): number | undefined {
  if (!entry || entry.type !== 5 || entry.count < 3 || !ref) return undefined;

  const deg = r.rational(entry.valueOffset);
  const min = r.rational(entry.valueOffset + 8);
  const sec = r.rational(entry.valueOffset + 16);
  if (deg === undefined || min === undefined || sec === undefined) return undefined;

  const magnitude = deg + min / 60 + sec / 3600;
  if (!Number.isFinite(magnitude) || magnitude > 180) return undefined;

  const hemisphere = ref.trim().toUpperCase();
  if (hemisphere === 'S' || hemisphere === 'W') return -magnitude;
  if (hemisphere === 'N' || hemisphere === 'E') return magnitude;
  return undefined;
}

/* ── Segment walking ───────────────────────────────────────────────────────── */

/** Find the TIFF block inside the first EXIF APP1 segment, if there is one. */
function findExifTiff(bytes: Uint8Array): Uint8Array | undefined {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;

  let i = 2;
  while (i + 4 <= bytes.byteLength) {
    if (bytes[i] !== 0xff) return undefined; // not at a marker: give up quietly
    const marker = bytes[i + 1]!;

    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // Start of scan: entropy-coded data follows; EXIF is never past here.
    if (marker === 0xda || marker === 0xd9) return undefined;

    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (length < 2 || i + 2 + length > bytes.byteLength) return undefined;

    if (marker === 0xe1) {
      const payload = bytes.subarray(i + 4, i + 2 + length);
      const isExif =
        payload.byteLength > 6 &&
        payload[0] === 0x45 && // E
        payload[1] === 0x78 && // x
        payload[2] === 0x69 && // i
        payload[3] === 0x66 && // f
        payload[4] === 0x00 &&
        payload[5] === 0x00;
      if (isExif) return payload.subarray(6);
    }
    i += 2 + length;
  }
  return undefined;
}

/* ── Entry point ───────────────────────────────────────────────────────────── */

/**
 * Extract capture time and GPS. Returns `{}` for anything it cannot read —
 * a PNG, a truncated upload, a hostile file, a photo with no EXIF at all.
 */
export function extractExif(bytes: Uint8Array): ExtractedExif {
  try {
    const tiff = findExifTiff(bytes);
    if (!tiff || tiff.byteLength < 8) return EMPTY;

    const b0 = tiff[0]!;
    const b1 = tiff[1]!;
    const littleEndian = b0 === 0x49 && b1 === 0x49;
    const bigEndian = b0 === 0x4d && b1 === 0x4d;
    if (!littleEndian && !bigEndian) return EMPTY;

    const r = new TiffReader(tiff, littleEndian);
    if (r.u16(2) !== 42) return EMPTY;

    const ifd0Offset = r.u32(4);
    if (ifd0Offset === undefined) return EMPTY;

    const seen = new Set<number>();
    const ifd0 = readIfd(r, ifd0Offset, seen);

    const exifPointer = ifd0.get(TAG_EXIF_IFD);
    const gpsPointer = ifd0.get(TAG_GPS_IFD);

    const exifIfd = exifPointer
      ? readIfd(r, r.u32(exifPointer.valueOffset) ?? 0, seen)
      : new Map<number, IfdEntry>();
    const gpsIfd = gpsPointer
      ? readIfd(r, r.u32(gpsPointer.valueOffset) ?? 0, seen)
      : new Map<number, IfdEntry>();

    const readAscii = (map: Map<number, IfdEntry>, tag: number): string | undefined => {
      const e = map.get(tag);
      if (!e || e.type !== 2) return undefined;
      return r.ascii(e.valueOffset, e.count);
    };

    const capturedAt = toIso(
      readAscii(exifIfd, TAG_DATETIME_ORIGINAL) ?? readAscii(exifIfd, TAG_DATETIME_DIGITIZED),
      readAscii(exifIfd, TAG_OFFSET_TIME_ORIGINAL),
    );

    const lat = toDecimalDegrees(r, gpsIfd.get(TAG_GPS_LAT), readAscii(gpsIfd, TAG_GPS_LAT_REF));
    const lon = toDecimalDegrees(r, gpsIfd.get(TAG_GPS_LON), readAscii(gpsIfd, TAG_GPS_LON_REF));

    const result: { capturedAt?: string; gps?: string } = {};
    if (capturedAt) result.capturedAt = capturedAt;
    if (lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      result.gps = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    }
    return result;
  } catch {
    // Total by contract. Unreadable EXIF must never cost a photograph its
    // record: the hash and the server-clock receivedAt are what it rests on.
    return EMPTY;
  }
}
