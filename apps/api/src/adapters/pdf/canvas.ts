/**
 * Shared PDF layout primitives — architecture.md §5.6.
 *
 * Extracted from `report.ts` so the Condition/Exit Report and the Demand
 * Letter draw on one page geometry, one font set, one wrapping rule and one
 * character sanitiser. Two templates with two private copies of `wrap` would
 * drift, and the first symptom would be a line of a legal document falling off
 * the right margin of one document type and not the other.
 *
 * Nothing here decides *what* a document says. These are drawing tools; the
 * content models in `domain/documents/` own the words.
 */
import { rgb } from 'pdf-lib';
import type { PDFDocument, PDFFont, PDFImage, PDFPage } from 'pdf-lib';

export const PAGE = { width: 595.28, height: 841.89 } as const; // A4 portrait, points
export const MARGIN = 48;
export const CONTENT_WIDTH = PAGE.width - MARGIN * 2;

export const INK = rgb(0.1, 0.1, 0.12);
export const MUTED = rgb(0.42, 0.42, 0.46);
export const RULE = rgb(0.85, 0.85, 0.88);

export interface Fonts {
  readonly body: PDFFont;
  readonly bold: PDFFont;
  readonly mono: PDFFont;
}

/** A cursor over a growing document, so callers never track page breaks. */
export class Canvas {
  #doc: PDFDocument;
  #fonts: Fonts;
  #page: PDFPage;
  #y: number;
  readonly pages: PDFPage[] = [];

  constructor(doc: PDFDocument, fonts: Fonts) {
    this.#doc = doc;
    this.#fonts = fonts;
    this.#page = this.#newPage();
    this.#y = PAGE.height - MARGIN;
  }

  #newPage(): PDFPage {
    const page = this.#doc.addPage([PAGE.width, PAGE.height]);
    this.pages.push(page);
    return page;
  }

  /** Ensure `height` points are available, breaking to a new page if not. */
  reserve(height: number): void {
    if (this.#y - height < MARGIN + 28) {
      this.#page = this.#newPage();
      this.#y = PAGE.height - MARGIN;
    }
  }

  text(
    value: string,
    options: { size?: number; bold?: boolean; mono?: boolean; color?: ReturnType<typeof rgb>; indent?: number } = {},
  ): void {
    const size = options.size ?? 10;
    const font = options.mono ? this.#fonts.mono : options.bold ? this.#fonts.bold : this.#fonts.body;
    this.reserve(size + 4);
    this.#y -= size + 2;
    this.#page.drawText(sanitise(value), {
      x: MARGIN + (options.indent ?? 0),
      y: this.#y,
      size,
      font,
      color: options.color ?? INK,
    });
    this.#y -= 2;
  }

  gap(points = 8): void {
    this.#y -= points;
  }

  rule(): void {
    this.reserve(10);
    this.#y -= 6;
    this.#page.drawLine({
      start: { x: MARGIN, y: this.#y },
      end: { x: MARGIN + CONTENT_WIDTH, y: this.#y },
      thickness: 0.5,
      color: RULE,
    });
    this.#y -= 6;
  }

  image(image: PDFImage, width: number, height: number): void {
    this.reserve(height + 6);
    this.#y -= height;
    this.#page.drawImage(image, { x: MARGIN, y: this.#y, width, height });
    this.#y -= 4;
  }

  get font(): Fonts {
    return this.#fonts;
  }
}

/**
 * WinAnsi cannot encode every character a tenant might type, and pdf-lib
 * throws on one it cannot draw — which would fail the whole document over a
 * curly quote. Replacing the common typographic characters and dropping the
 * rest keeps a stray character from costing the tenant their report.
 */
export function sanitise(value: string): string {
  return value
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E]/g, '');
}

/** Wrap to the content width, measured in the font it will be drawn in. */
export function wrap(value: string, font: PDFFont, size: number, width = CONTENT_WIDTH): string[] {
  const words = sanitise(value).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(2)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}


/** Draw the footer record id on every page, once the page count is known. */
export function drawFooters(doc: PDFDocument, fonts: Fonts, recordRef: string): number {
  const pages = doc.getPages();
  pages.forEach((page, index) => {
    page.drawText(sanitise(`${recordRef}  ·  page ${index + 1} of ${pages.length}`), {
      x: MARGIN,
      y: MARGIN - 18,
      size: 7,
      font: fonts.mono,
      color: MUTED,
    });
  });
  return pages.length;
}
