import { inflateSync } from 'node:zlib';

/**
 * Every text string a PDF actually draws.
 *
 * pdf-lib ships no text extractor, so the content streams are pulled from the
 * file and inflated. The inflation is the part that matters: page content is
 * Flate-compressed, so a raw byte search finds nothing — which makes a naive
 * `not.toContain(...)` assertion pass for **any** input and quietly prove
 * nothing at all. Several of the assertions built on this are of exactly that
 * shape ("a rejected change must not appear in the PDF"), so they are only
 * worth anything if the text is genuinely readable here.
 *
 * pdf-lib writes show-text operands as hex strings (`<48454C...> Tj`); literal
 * strings are handled too, since either is legal.
 */
export function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes);
  const chunks: string[] = [];

  let at = 0;
  for (;;) {
    const start = raw.indexOf('stream', at);
    if (start === -1) break;
    const end = raw.indexOf('endstream', start);
    if (end === -1) break;

    // Skip the EOL after the `stream` keyword (CRLF or LF).
    let from = start + 'stream'.length;
    if (raw[from] === 0x0d) from += 1;
    if (raw[from] === 0x0a) from += 1;

    const body = raw.subarray(from, end);
    let content: string;
    try {
      content = inflateSync(body).toString('latin1');
    } catch {
      // Not a compressed stream (an embedded image, say) — read it as-is.
      content = body.toString('latin1');
    }

    for (const match of content.matchAll(/<([0-9A-Fa-f\s]*)>\s*Tj/g)) {
      chunks.push(Buffer.from((match[1] ?? '').replace(/\s+/g, ''), 'hex').toString('latin1'));
    }
    for (const match of content.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) {
      chunks.push((match[1] ?? '').replace(/\\([()\\])/g, '$1'));
    }
    at = end + 'endstream'.length;
  }

  return chunks.join('\n');
}

/**
 * The same text, read as continuous prose.
 *
 * `pdfText` joins each drawn string with a newline, which is the right shape
 * for asserting that a particular line exists. It is the wrong shape for
 * asserting that the document *says* something: a sentence laid out over two
 * lines extracts as `...it is not legal\nadvice...`, and a phrase assertion
 * against it fails even though a human reading the page sees the sentence
 * whole. Collapsing the breaks asserts what the reader actually reads.
 */
export function pdfProse(bytes: Uint8Array): string {
  return pdfText(bytes).replace(/\s+/g, ' ').trim();
}
