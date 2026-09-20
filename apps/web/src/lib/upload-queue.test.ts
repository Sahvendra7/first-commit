import { describe, expect, it, vi } from 'vitest';
import { LIMITS } from '@handover/shared';
import { DemoApiClient } from './demo/client.js';
import { DEMO_ROOMS, DEMO_TENANCY_ID } from './demo/tenancy.js';
import { UploadQueue, type QueuedPhoto } from './upload-queue.js';
import type { DownscaleResult } from './image-resize.js';

const ROOM_ID = DEMO_ROOMS[0]!.roomId;

function file(name: string, bytes = 3_000_000): File {
  return new File([new Uint8Array(8)], name, { type: 'image/jpeg' });
  // Size is irrelevant: the queue reads the size of the *downscaled* blob.
  void bytes;
}

/** A downscale stub, so no canvas is involved in the queue's own tests. */
function fakeDownscale(size = 350_000): (blob: Blob) => Promise<DownscaleResult> {
  return async () => ({
    blob: new Blob([new Uint8Array(size)], { type: 'image/jpeg' }),
    width: 1600,
    height: 1200,
    contentType: 'image/jpeg',
  });
}

function makeQueue(
  overrides: Partial<ConstructorParameters<typeof UploadQueue>[0]> = {},
): { queue: UploadQueue; api: DemoApiClient; snapshots: (readonly QueuedPhoto[])[] } {
  const api = (overrides.api as DemoApiClient) ?? new DemoApiClient();
  const snapshots: (readonly QueuedPhoto[])[] = [];
  const queue = new UploadQueue({
    api,
    tenancyId: DEMO_TENANCY_ID,
    phase: 'MOVEIN',
    roomId: ROOM_ID,
    onChange: (photos) => snapshots.push(photos),
    downscale: fakeDownscale(),
    sleep: async () => {},
    ...overrides,
  });
  return { queue, api, snapshots };
}

describe('UploadQueue — the happy path', () => {
  it('drives every photo to UPLOADED', async () => {
    const { queue } = makeQueue();
    await queue.add([file('a.jpg'), file('b.jpg')]);

    expect(queue.photos.map((p) => p.status)).toEqual(['UPLOADED', 'UPLOADED']);
    expect(queue.uploadedCount).toBe(2);
    expect(queue.hasFailures).toBe(false);
    expect(queue.isBusy).toBe(false);
  });

  it('gives each photo a distinct clientRef, so a policy matches its blob', async () => {
    const { queue } = makeQueue();
    await queue.add([file('a.jpg'), file('b.jpg'), file('c.jpg')]);
    const refs = queue.photos.map((p) => p.clientRef);
    expect(new Set(refs).size).toBe(3);
  });

  it('records the downscaled size and dimensions, not the original', async () => {
    const { queue } = makeQueue({ downscale: fakeDownscale(350_000) });
    await queue.add([file('a.jpg')]);
    const photo = queue.photos[0]!;
    expect(photo.bytes).toBe(350_000);
    expect(photo.width).toBe(1600);
    expect(photo.height).toBe(1200);
  });

  it('keeps the file name, so a failure names a photo the tenant recognises', async () => {
    const { queue } = makeQueue();
    await queue.add([file('kitchen-sink.jpg')]);
    expect(queue.photos[0]!.fileName).toBe('kitchen-sink.jpg');
  });

  it('records the s3Key S3 acknowledged', async () => {
    const { queue } = makeQueue();
    await queue.add([file('a.jpg')]);
    expect(queue.photos[0]!.s3Key).toContain(ROOM_ID);
  });

  it('reports progress per photo, never as one aggregate (R5)', async () => {
    const { queue, snapshots } = makeQueue();
    await queue.add([file('a.jpg'), file('b.jpg')]);

    const seen = new Set(snapshots.flatMap((s) => s.map((p) => p.status)));
    expect(seen.has('QUEUED')).toBe(true);
    expect(seen.has('PREPARING')).toBe(true);
    expect(seen.has('UPLOADING')).toBe(true);
    expect(seen.has('UPLOADED')).toBe(true);
  });

  it('appends to an existing queue rather than replacing it', async () => {
    const { queue } = makeQueue();
    await queue.add([file('a.jpg')]);
    await queue.add([file('b.jpg')]);
    expect(queue.photos).toHaveLength(2);
    expect(queue.uploadedCount).toBe(2);
  });
});

describe('UploadQueue — presign batching', () => {
  it('never asks for more than the batch limit in one call', async () => {
    const api = new DemoApiClient();
    const spy = vi.spyOn(api, 'presignPhotos');
    const { queue } = makeQueue({ api });

    await queue.add(Array.from({ length: 12 }, (_, i) => file(`p${i}.jpg`)));

    expect(queue.uploadedCount).toBe(12);
    for (const call of spy.mock.calls) {
      expect(call[1].files.length).toBeLessThanOrEqual(LIMITS.MAX_PRESIGN_BATCH);
    }
  });

  it('sends the phase and room with every presign', async () => {
    const api = new DemoApiClient();
    const spy = vi.spyOn(api, 'presignPhotos');
    const { queue } = makeQueue({ api });
    await queue.add([file('a.jpg')]);

    expect(spy.mock.calls[0]![1]).toMatchObject({ phase: 'MOVEIN', roomId: ROOM_ID });
  });
});

describe('UploadQueue — failure and retry (risk R5)', () => {
  it('retries automatically and succeeds on the second attempt', async () => {
    const api = new DemoApiClient({ failFirstUpload: true });
    const { queue } = makeQueue({ api });

    await queue.add([file('a.jpg')]);

    expect(queue.photos[0]!.status).toBe('UPLOADED');
    expect(queue.photos[0]!.attempts).toBe(2);
  });

  it('surfaces a photo as FAILED once the automatic attempts are spent', async () => {
    const api = new DemoApiClient();
    vi.spyOn(api, 'uploadPhoto').mockRejectedValue(new Error('network down'));
    const { queue } = makeQueue({ api, maxAttempts: 2 });

    await queue.add([file('a.jpg')]);

    const photo = queue.photos[0]!;
    expect(photo.status).toBe('FAILED');
    expect(photo.attempts).toBe(2);
    expect(photo.error).toContain('network down');
    expect(queue.hasFailures).toBe(true);
  });

  it('backs off between attempts', async () => {
    const api = new DemoApiClient();
    vi.spyOn(api, 'uploadPhoto').mockRejectedValue(new Error('network down'));
    const sleep = vi.fn(async (_ms: number) => {});
    const { queue } = makeQueue({ api, maxAttempts: 3, sleep });

    await queue.add([file('a.jpg')]);

    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000]);
  });

  it('does not abandon the rest of the selection when one photo fails', async () => {
    const api = new DemoApiClient();
    const real = api.uploadPhoto.bind(api);
    vi.spyOn(api, 'uploadPhoto').mockImplementation(async (upload, blob, options) => {
      if (upload.clientRef.endsWith('002')) throw new Error('this one is cursed');
      return real(upload, blob, options);
    });
    const { queue } = makeQueue({ api, maxAttempts: 1 });

    await queue.add([file('a.jpg'), file('b.jpg'), file('c.jpg')]);

    expect(queue.photos.map((p) => p.status)).toEqual(['UPLOADED', 'FAILED', 'UPLOADED']);
    expect(queue.uploadedCount).toBe(2);
  });

  it('retries one failed photo by hand without re-taking it', async () => {
    const api = new DemoApiClient();
    const real = api.uploadPhoto.bind(api);
    let failing = true;
    vi.spyOn(api, 'uploadPhoto').mockImplementation(async (upload, blob, options) => {
      if (failing) throw new Error('network down');
      return real(upload, blob, options);
    });
    const { queue } = makeQueue({ api, maxAttempts: 1 });

    await queue.add([file('a.jpg')]);
    expect(queue.photos[0]!.status).toBe('FAILED');

    failing = false;
    await queue.retry(queue.photos[0]!.clientRef);

    expect(queue.photos[0]!.status).toBe('UPLOADED');
    expect(queue.photos[0]!.error).toBeUndefined();
  });

  it('retries every failed photo at once', async () => {
    const api = new DemoApiClient();
    const real = api.uploadPhoto.bind(api);
    let failing = true;
    vi.spyOn(api, 'uploadPhoto').mockImplementation(async (upload, blob, options) => {
      if (failing) throw new Error('network down');
      return real(upload, blob, options);
    });
    const { queue } = makeQueue({ api, maxAttempts: 1 });

    await queue.add([file('a.jpg'), file('b.jpg')]);
    expect(queue.uploadedCount).toBe(0);

    failing = false;
    await queue.retryAll();

    expect(queue.uploadedCount).toBe(2);
    expect(queue.hasFailures).toBe(false);
  });

  it('ignores a retry for a photo that is not failed', async () => {
    const { queue } = makeQueue();
    await queue.add([file('a.jpg')]);
    await queue.retry(queue.photos[0]!.clientRef);
    expect(queue.photos[0]!.status).toBe('UPLOADED');
  });
});

describe('UploadQueue — stale policies and oversized files', () => {
  it('refuses to POST against a policy that is about to expire', async () => {
    const api = new DemoApiClient();
    vi.spyOn(api, 'presignPhotos').mockResolvedValue({
      uploads: [
        {
          clientRef: `${ROOM_ID}-MOVEIN-001`,
          url: 'https://demo.invalid/upload',
          fields: {},
          s3Key: 'k',
          // Already in the past.
          expiresAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    });
    const uploadSpy = vi.spyOn(api, 'uploadPhoto');
    const { queue } = makeQueue({ api, maxAttempts: 1 });

    await queue.add([file('a.jpg')]);

    expect(queue.photos[0]!.status).toBe('FAILED');
    expect(queue.photos[0]!.error).toContain('expired');
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('re-presigns on each attempt rather than reusing a policy', async () => {
    const api = new DemoApiClient({ failFirstUpload: true });
    const spy = vi.spyOn(api, 'presignPhotos');
    const { queue } = makeQueue({ api });

    await queue.add([file('a.jpg')]);

    expect(queue.photos[0]!.status).toBe('UPLOADED');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('fails a photo that is still over the size limit after downscaling', async () => {
    const { queue } = makeQueue({
      downscale: fakeDownscale(LIMITS.MAX_PHOTO_BYTES + 1),
    });
    await queue.add([file('huge.jpg')]);

    expect(queue.photos[0]!.status).toBe('FAILED');
    expect(queue.photos[0]!.error).toContain('8 MB');
  });

  it('fails a photo the browser could not decode, and says so', async () => {
    const { queue } = makeQueue({
      downscale: async () => {
        throw new Error('the browser could not decode this image');
      },
    });
    await queue.add([file('broken.jpg')]);

    expect(queue.photos[0]!.status).toBe('FAILED');
    expect(queue.photos[0]!.error).toContain('could not decode');
  });
});

describe('UploadQueue — lifecycle', () => {
  it('does nothing when handed an empty selection', async () => {
    const { queue, snapshots } = makeQueue();
    await queue.add([]);
    expect(queue.photos).toHaveLength(0);
    expect(snapshots).toHaveLength(0);
  });

  it('revokes thumbnail object URLs on dispose', async () => {
    const revokeObjectUrl = vi.fn();
    const { queue } = makeQueue({
      createObjectUrl: () => 'blob:preview',
      revokeObjectUrl,
    });
    await queue.add([file('a.jpg')]);
    queue.dispose();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:preview');
  });

  it('accepts nothing once disposed', async () => {
    const { queue } = makeQueue();
    queue.dispose();
    await queue.add([file('a.jpg')]);
    expect(queue.photos).toHaveLength(0);
  });
});
