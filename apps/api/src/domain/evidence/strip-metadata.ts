/**
 * Metadata stripping for outbound derivatives — architecture.md §5.4, §10.1;
 * `demo-safety`.
 *
 * The rule this implements has two halves, and the second is the one that is
 * easy to get wrong:
 *
 *   **Strip EXIF (including GPS) from images embedded in outbound PDFs.
 *    Never from the stored original.**
 *
 * The stored object must stay byte-identical to what its SHA-256 attests, or
 * the hash attests to nothing and the ledger's central claim collapses. So
 * this function never writes to S3 and never touches the input: it takes
 * bytes, returns new bytes, and the caller embeds *those* in the PDF.
 *
 * The harm it prevents is concrete. An outbound Condition Report goes to a
 * landlord. A phone photograph of a home carries its GPS coordinates, and a
 * tenant in a deposit dispute may have moved out precisely to get away from
 * the person receiving the document.
 *
 * ── Why every APPn, not just APP1 ───────────────────────────────────────────
 * EXIF lives in APP1, but so does XMP — which carries location and device
 * metadata under a different namespace — and Photoshop IRB in APP13 can carry
 * IPTC location fields. Enumerating the segments that are *safe* is a list
 * that goes stale; dropping every APPn and COM is a list that cannot. The cost
 * is the ICC colour profile in APP2, which means a derivative may render with
 * slightly different colour. That is the right trade for a document whose
 * purpose is to record that a wall had a stain on it, not to be colour-exact.
 *
 * Domain module: no AWS imports, no I/O. Total by contract — it runs inside a
 * worker on bytes a stranger uploaded, so it never throws and never loops.
 */

/** Marker bytes that carry no length and no payload. */
function isStandalone(marker: number): boolean {
  return marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

/**
 * Segments to drop: every application segment (`APP0`–`APP15`) and the comment
 * segment. Everything else — quantisation tables, Huffman tables, frame
 * headers, the scan — is the image and is kept.
 *
 * APP0/JFIF is dropped with the rest. It carries only density and thumbnail
 * information, and decoders treat its absence as the default.
 */
function isMetadata(marker: number): boolean {
  return (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
}

/**
 * Return a copy of `bytes` with all metadata segments removed.
 *
 * Anything that is not a JPEG this function is confident it understands — a
 * PNG, a WebP, a truncated upload, a file whose segment lengths lie — is
 * returned as an unmodified copy. Refusing to guess is the safe direction: a
 * corrupted derivative is a broken document, while an un-stripped one is
 * caught by the caller, which only embeds what this returns for formats it
 * knows carry no such metadata.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  const copy = (): Uint8Array => Uint8Array.prototype.slice.call(bytes);

  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return copy();

  // Ranges of the input to keep, in order. The SOI is always the first.
  const keep: Array<[number, number]> = [[0, 2]];
  let i = 2;

  while (i + 2 <= bytes.byteLength) {
    if (bytes[i] !== 0xff) return copy(); // lost the marker stream — do not guess
    const marker = bytes[i + 1]!;

    if (isStandalone(marker)) {
      keep.push([i, i + 2]);
      i += 2;
      continue;
    }

    // Start of scan: everything from here to the end is entropy-coded image
    // data, which contains no segments and must be copied verbatim.
    if (marker === 0xda) {
      keep.push([i, bytes.byteLength]);
      i = bytes.byteLength;
      break;
    }

    if (marker === 0xd9) {
      keep.push([i, i + 2]);
      i += 2;
      break;
    }

    if (i + 4 > bytes.byteLength) return copy();
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    // A length below 2 cannot include its own bytes, and one past the end is
    // a lie. Either way the stream is not what it claims and is left alone.
    if (length < 2 || i + 2 + length > bytes.byteLength) return copy();

    if (!isMetadata(marker)) keep.push([i, i + 2 + length]);
    i += 2 + length;
  }

  const size = keep.reduce((n, [from, to]) => n + (to - from), 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const [from, to] of keep) {
    out.set(bytes.subarray(from, to), at);
    at += to - from;
  }
  return out;
}
