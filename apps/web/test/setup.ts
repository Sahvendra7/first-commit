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
 * jsdom's canvas has no 2D context. `toBlob` is stubbed to produce a
 * deterministic, correctly-typed blob so the upload path can be tested; the
 * dimension arithmetic it depends on lives in `lib/image-resize.ts` and is
 * tested directly, with no canvas involved.
 */
if (!HTMLCanvasElement.prototype.toBlob) {
  HTMLCanvasElement.prototype.toBlob = function toBlob(
    callback: BlobCallback,
    type?: string,
  ): void {
    callback(new Blob(['stub-canvas-bytes'], { type: type ?? 'image/png' }));
  };
}
