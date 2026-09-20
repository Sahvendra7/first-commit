/**
 * jsdom does not implement PointerEvent, `setPointerCapture`, or
 * `HTMLCanvasElement.prototype.toBlob`. All three are load-bearing here:
 * the compare slider and the change marker are pointer-driven, and the capture
 * pipeline downscales through a canvas before upload (§5.1).
 *
 * These are the narrowest possible stand-ins — enough for the browser APIs the
 * components call to exist and behave predictably, and nothing more. Anything
 * that depends on real rasterisation is tested against the pure functions in
 * `src/lib/` instead.
 */

class PointerEventPolyfill extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
    this.isPrimary = init.isPrimary ?? true;
  }
}

if (typeof globalThis.PointerEvent === 'undefined') {
  globalThis.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = function setPointerCapture() {
    /* capture is a no-op in jsdom; events are dispatched at the element anyway */
  };
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = function releasePointerCapture() {
    /* see above */
  };
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = function hasPointerCapture() {
    return false;
  };
}

/**
 * jsdom's canvas has no 2D context, and its `toBlob` **exists but is not
 * implemented** without the optional `canvas` package — it reports to the
 * virtual console and never calls back, which hangs any promise wrapping it.
 * So this is an unconditional override, not a `if (!…)` fallback.
 *
 * It produces a deterministic, correctly-typed blob so the upload path can be
 * tested. The dimension arithmetic that decides what gets drawn lives in
 * `lib/image-resize.ts` and is tested directly, with no canvas involved.
 */
HTMLCanvasElement.prototype.toBlob = function toBlob(
  callback: BlobCallback,
  type?: string,
): void {
  callback(new Blob(['stub-canvas-bytes'], { type: type ?? 'image/png' }));
};

/**
 * jsdom implements neither `URL.createObjectURL` nor `URL.revokeObjectURL`.
 * The capture queue uses them for thumbnails, so they exist here as counters
 * with no backing store — enough for a test to assert that a preview was
 * created and later released.
 */
let objectUrlSeq = 0;
if (!URL.createObjectURL) {
  URL.createObjectURL = function createObjectURL(): string {
    objectUrlSeq += 1;
    return `blob:handover/${objectUrlSeq}`;
  };
}
if (!URL.revokeObjectURL) {
  URL.revokeObjectURL = function revokeObjectURL(): void {
    /* nothing is retained, so nothing is released */
  };
}
