/**
 * Client-side downscale before upload — §5.1's "key design point".
 *
 * Resize the long edge to ~1600px and re-encode at quality 0.8 in a canvas.
 * That cuts ~3 MB to ~350 KB, which reduces upload failures on weak networks
 * (NFR-3), cuts storage cost ~8x, and matches the resolution the vision model
 * actually consumes.
 *
 * **The original device file is not retained** — a deliberate trade-off
 * documented in §17 (R7). Nothing in this module keeps a reference to the
 * source `File` past the encode.
 */

/** §5.1: long edge ~1600px. */
export const MAX_EDGE_PX = 1600;
/** §5.1: re-encode at quality 0.8. */
export const ENCODE_QUALITY = 0.8;
/** One of `ALLOWED_PHOTO_CONTENT_TYPES`; JPEG is what a phone camera produces. */
export const ENCODE_CONTENT_TYPE = 'image/jpeg';

export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

export interface DownscaleResult {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
  readonly contentType: string;
}

export interface DownscaleOptions {
  readonly maxEdge?: number;
  readonly quality?: number;
  readonly contentType?: string;
}

/**
 * The dimension arithmetic, split out from the canvas so it can be tested
 * without one. Scales the **long** edge down to `maxEdge`, preserving aspect
 * ratio; an image already within budget is returned unchanged rather than
 * upscaled — re-encoding a small photo larger would add bytes and no detail.
 *
 * Rounds to whole pixels and never returns a zero edge: a 1600x1 panorama
 * still has to produce a canvas a browser will accept.
 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number = MAX_EDGE_PX,
): Dimensions {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`cannot resize an image of ${width}x${height}`);
  }
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  const scale = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Decodes a file to something drawable, preferring the off-main-thread path. */
async function decode(file: Blob): Promise<CanvasImageSource & Dimensions> {
  if (typeof createImageBitmap === 'function') {
    return (await createImageBitmap(file)) as ImageBitmap;
  }
  // Safari < 15 and jsdom: fall back to an <img> and an object URL.
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement & Dimensions>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img as HTMLImageElement & Dimensions);
      img.onerror = () => reject(new Error('the browser could not decode this image'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBlob(canvas: HTMLCanvasElement, contentType: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas encode produced no blob'))),
      contentType,
      quality,
    );
  });
}

/**
 * Downscales and re-encodes one captured photo.
 *
 * Throws rather than silently returning the original: an oversized upload that
 * fails on a weak network at the property is worse than a photo the tenant is
 * told to retake.
 */
export async function downscaleImage(
  file: Blob,
  options: DownscaleOptions = {},
): Promise<DownscaleResult> {
  const maxEdge = options.maxEdge ?? MAX_EDGE_PX;
  const quality = options.quality ?? ENCODE_QUALITY;
  const contentType = options.contentType ?? ENCODE_CONTENT_TYPE;

  const source = await decode(file);
  try {
    const { width, height } = fitWithin(source.width, source.height, maxEdge);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable — cannot downscale');
    ctx.drawImage(source, 0, 0, width, height);

    const blob = await toBlob(canvas, contentType, quality);
    return { blob, width, height, contentType };
  } finally {
    // Release the decoded bitmap promptly; a 12MP capture is ~48 MB in memory
    // and a six-room walkthrough will exhaust a phone otherwise.
    if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
      source.close();
    }
  }
}
