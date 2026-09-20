/**
 * Per-photo upload state — §14 (`lib/upload-queue.ts`), web-contract §5.
 *
 * "Upload failure at the property is silent, total evidence loss at the exact
 * moment of capture (risk R5), so per-photo state must be visible, never a
 * single aggregate bar." That sentence is the whole design. Every photo is
 * tracked individually, every failure is attributable to a named file, and
 * every failure is retryable without re-taking the photograph.
 *
 * The three legs (web-contract §5): downscale on device -> presign in batches
 * of ten -> direct POST to S3. The API never touches the image bytes.
 *
 * Deliberately **not** here: any notion of "done". A 204 means S3 has the
 * object, not that the system has the evidence — `photo-ingest` still has to
 * hash it, stamp the server clock and increment the room counter. Only
 * `RoomSummary.photoCount*` confirms that, and it comes from the server.
 */
import { LIMITS, type Phase, type PhotoContentType } from '@handover/shared';
import type { HandoverApiClient } from './api-client.js';
import { downscaleImage, type DownscaleResult } from './image-resize.js';

export type UploadStatus =
  /** Accepted from the file input, not yet touched. */
  | 'QUEUED'
  /** Downscaling and re-encoding in a canvas. */
  | 'PREPARING'
  /** Presigned and POSTing to S3. */
  | 'UPLOADING'
  /** S3 returned 204. **Not** the same as "the system has the evidence". */
  | 'UPLOADED'
  /** Gave up after the automatic attempts. Retryable by hand. */
  | 'FAILED';

export interface QueuedPhoto {
  /** Our correlation id, echoed by presign so a policy matches its blob. */
  readonly clientRef: string;
  readonly fileName: string;
  readonly status: UploadStatus;
  /** Attempts spent so far, including the one in flight. */
  readonly attempts: number;
  /** Human-readable reason, set only when `status` is FAILED. */
  readonly error?: string;
  /** Size after downscale, in bytes. */
  readonly bytes?: number;
  readonly width?: number;
  readonly height?: number;
  readonly s3Key?: string;
  /** Object URL for the thumbnail. Revoked when the queue is disposed. */
  readonly previewUrl?: string;
}

export interface UploadQueueOptions {
  readonly api: HandoverApiClient;
  readonly tenancyId: string;
  readonly phase: Phase;
  readonly roomId: string;
  readonly onChange: (photos: readonly QueuedPhoto[]) => void;
  /** Automatic attempts per photo before it is surfaced as FAILED. */
  readonly maxAttempts?: number;
  /** Injected for determinism in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly downscale?: (file: Blob) => Promise<DownscaleResult>;
  readonly now?: () => number;
  readonly createObjectUrl?: (blob: Blob) => string;
  readonly revokeObjectUrl?: (url: string) => void;
}

/**
 * A presigned policy is only good for a few minutes. Re-presigning is cheap;
 * retrying a stale policy is a guaranteed failure that looks like a network
 * problem, so anything inside this margin is treated as already expired.
 */
const EXPIRY_MARGIN_MS = 30_000;

const DEFAULT_MAX_ATTEMPTS = 3;

function backoffMs(attempt: number): number {
  return 500 * 2 ** (attempt - 1);
}

/** The subset of `ALLOWED_PHOTO_CONTENT_TYPES` the canvas encoder produces. */
function contentTypeOf(result: DownscaleResult): PhotoContentType {
  return result.contentType === 'image/png' || result.contentType === 'image/webp'
    ? result.contentType
    : 'image/jpeg';
}

export class UploadQueue {
  readonly #options: Required<
    Pick<UploadQueueOptions, 'maxAttempts' | 'sleep' | 'downscale' | 'now'>
  > &
    UploadQueueOptions;

  #photos: QueuedPhoto[] = [];
  #blobs = new Map<string, Blob>();
  #seq = 0;
  #disposed = false;

  constructor(options: UploadQueueOptions) {
    this.#options = {
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      downscale: options.downscale ?? ((file) => downscaleImage(file)),
      now: options.now ?? (() => Date.now()),
      ...options,
    };
  }

  get photos(): readonly QueuedPhoto[] {
    return this.#photos;
  }

  /** Photos S3 has acknowledged. The client's count for `declaredPhotoCount`. */
  get uploadedCount(): number {
    return this.#photos.filter((p) => p.status === 'UPLOADED').length;
  }

  get hasFailures(): boolean {
    return this.#photos.some((p) => p.status === 'FAILED');
  }

  /** True while any photo is still moving. */
  get isBusy(): boolean {
    return this.#photos.some((p) => p.status !== 'UPLOADED' && p.status !== 'FAILED');
  }

  #emit(): void {
    this.#photos = [...this.#photos];
    this.#options.onChange(this.#photos);
  }

  #patch(clientRef: string, patch: Partial<QueuedPhoto>): void {
    const index = this.#photos.findIndex((p) => p.clientRef === clientRef);
    if (index === -1) return;
    const current = this.#photos[index];
    if (!current) return;
    this.#photos[index] = { ...current, ...patch };
    this.#emit();
  }

  /**
   * Accepts a selection from the file input and drives it to completion.
   * Resolves when nothing is left in flight; individual failures are reported
   * through `onChange`, not thrown, because one bad photo must not abandon the
   * other five.
   */
  async add(files: readonly File[]): Promise<void> {
    if (this.#disposed || files.length === 0) return;

    const accepted: QueuedPhoto[] = files.map((file) => {
      this.#seq += 1;
      const clientRef = `${this.#options.roomId}-${this.#options.phase}-${String(
        this.#seq,
      ).padStart(3, '0')}`;
      this.#blobs.set(clientRef, file);
      return {
        clientRef,
        fileName: file.name,
        status: 'QUEUED' as const,
        attempts: 0,
        ...(this.#options.createObjectUrl
          ? { previewUrl: this.#options.createObjectUrl(file) }
          : {}),
      };
    });

    this.#photos = [...this.#photos, ...accepted];
    this.#emit();

    // Presign is capped at ten files per call, so the selection is chunked.
    // A batch of eleven is a wasted round trip and a 422 in front of the user.
    for (let i = 0; i < accepted.length; i += LIMITS.MAX_PRESIGN_BATCH) {
      const chunk = accepted.slice(i, i + LIMITS.MAX_PRESIGN_BATCH);
      await this.#processChunk(chunk.map((p) => p.clientRef));
    }
  }

  /** Retries one failed photo by hand, from wherever it got to. */
  async retry(clientRef: string): Promise<void> {
    const photo = this.#photos.find((p) => p.clientRef === clientRef);
    if (!photo || photo.status !== 'FAILED') return;
    this.#patch(clientRef, { status: 'QUEUED', attempts: 0, error: undefined });
    await this.#processChunk([clientRef]);
  }

  /** Retries every failed photo. The affordance after a tunnel or a lift. */
  async retryAll(): Promise<void> {
    const failed = this.#photos.filter((p) => p.status === 'FAILED').map((p) => p.clientRef);
    for (const clientRef of failed) {
      this.#patch(clientRef, { status: 'QUEUED', attempts: 0, error: undefined });
    }
    for (let i = 0; i < failed.length; i += LIMITS.MAX_PRESIGN_BATCH) {
      await this.#processChunk(failed.slice(i, i + LIMITS.MAX_PRESIGN_BATCH));
    }
  }

  /** Releases thumbnail object URLs. Call from an effect cleanup. */
  dispose(): void {
    this.#disposed = true;
    if (this.#options.revokeObjectUrl) {
      for (const photo of this.#photos) {
        if (photo.previewUrl) this.#options.revokeObjectUrl(photo.previewUrl);
      }
    }
    this.#blobs.clear();
  }

  async #processChunk(clientRefs: readonly string[]): Promise<void> {
    const prepared = await this.#prepareAll(clientRefs);
    if (prepared.length === 0) return;
    await this.#uploadAll(prepared);
  }

  /** Leg 0: downscale on device before anything touches the network. */
  async #prepareAll(
    clientRefs: readonly string[],
  ): Promise<{ clientRef: string; blob: Blob; contentType: PhotoContentType }[]> {
    const prepared: { clientRef: string; blob: Blob; contentType: PhotoContentType }[] = [];

    for (const clientRef of clientRefs) {
      const source = this.#blobs.get(clientRef);
      if (!source) continue;
      this.#patch(clientRef, { status: 'PREPARING' });

      try {
        const result = await this.#options.downscale(source);
        if (result.blob.size > LIMITS.MAX_PHOTO_BYTES) {
          throw new Error('still over the 8 MB limit after downscaling');
        }
        this.#patch(clientRef, {
          bytes: result.blob.size,
          width: result.width,
          height: result.height,
        });
        prepared.push({ clientRef, blob: result.blob, contentType: contentTypeOf(result) });
      } catch (error) {
        this.#fail(clientRef, `Could not prepare this photo: ${messageOf(error)}`);
      }
    }

    return prepared;
  }

  /** Legs 1 and 2: presign the batch, then POST each file direct to S3. */
  async #uploadAll(
    prepared: readonly { clientRef: string; blob: Blob; contentType: PhotoContentType }[],
  ): Promise<void> {
    for (const item of prepared) {
      await this.#uploadOne(item);
    }
  }

  async #uploadOne(item: {
    clientRef: string;
    blob: Blob;
    contentType: PhotoContentType;
  }): Promise<void> {
    const { api, tenancyId, phase, roomId, maxAttempts, sleep, now } = this.#options;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.#patch(item.clientRef, { status: 'UPLOADING', attempts: attempt });
      try {
        // Re-presigned on every attempt rather than reused. A policy that
        // expired between attempts fails in a way that looks exactly like a
        // network error, and chasing that at the property is time the tenant
        // does not have.
        const { uploads } = await api.presignPhotos(tenancyId, {
          phase,
          roomId,
          files: [
            {
              clientRef: item.clientRef,
              contentType: item.contentType,
              bytes: item.blob.size,
            },
          ],
        });

        const upload = uploads.find((u) => u.clientRef === item.clientRef);
        if (!upload) throw new Error('the server returned no policy for this photo');

        if (Date.parse(upload.expiresAt) - now() < EXPIRY_MARGIN_MS) {
          throw new Error('the upload policy expired before it could be used');
        }

        await api.uploadPhoto(upload, item.blob);
        this.#patch(item.clientRef, {
          status: 'UPLOADED',
          s3Key: upload.s3Key,
          error: undefined,
        });
        return;
      } catch (error) {
        if (attempt >= maxAttempts) {
          this.#fail(item.clientRef, messageOf(error));
          return;
        }
        await sleep(backoffMs(attempt));
      }
    }
  }

  #fail(clientRef: string, error: string): void {
    this.#patch(clientRef, { status: 'FAILED', error });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
