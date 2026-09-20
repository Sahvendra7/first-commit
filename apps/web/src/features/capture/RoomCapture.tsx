import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Phase } from '@handover/shared';
import type { HandoverApiClient } from '../../lib/api-client.js';
import { MAX_EDGE_PX } from '../../lib/image-resize.js';
import { UploadQueue, type QueuedPhoto } from '../../lib/upload-queue.js';

/**
 * Capture for one room, one phase (§5.1, web-contract §5).
 *
 * `<input type="file" accept="image/*" capture="environment" multiple>` — no
 * `getUserMedia`, no custom camera, no app install. §12: "Zero API surface;
 * works on all phones; no permission edge cases."
 *
 * Every photo is downscaled in a canvas to a ~1600px long edge at quality 0.8
 * *before* it touches the network, then uploaded direct to S3 through a
 * presigned POST. The API never sees the bytes.
 *
 * Two rules this component exists to honour:
 *
 * - **Per-photo status, never one aggregate bar.** Upload failure at the
 *   property is silent, total evidence loss at the moment of capture (risk
 *   R5). Each photo is listed by name with its own state and its own retry.
 * - **"Done" is the server's word, not ours.** A 204 means S3 has the object;
 *   `photo-ingest` still has to hash it, stamp the server clock and increment
 *   the room counter. `serverPhotoCount` comes from `RoomSummary` and is the
 *   only confirmation shown as confirmation.
 */

export interface RoomCaptureProps {
  readonly api: HandoverApiClient;
  readonly tenancyId: string;
  readonly roomId: string;
  readonly roomLabel: string;
  readonly phase: Phase;
  /**
   * `RoomSummary.photoCountMovein` / `photoCountMoveout` — maintained
   * server-side by `photo-ingest` with an atomic increment. This is the truth
   * about what was actually stored; a client-side tally is not.
   */
  readonly serverPhotoCount?: number;
  /**
   * Called after an operation settles, with **the number of photos that
   * operation newly landed in S3** — not the running total for this room.
   *
   * The distinction is load-bearing. A caller reconciling against the server's
   * room counter adds this to the count it read beforehand; handing it a
   * cumulative total would re-count the first selection on the second, and
   * invent an expected count the server can never reach.
   */
  readonly onUploaded?: (newlyUploadedCount: number) => void;
  readonly className?: string;
}

const STATUS_COPY: Record<QueuedPhoto['status'], string> = {
  QUEUED: 'Waiting',
  PREPARING: 'Resizing',
  UPLOADING: 'Uploading',
  UPLOADED: 'Sent',
  FAILED: 'Not sent',
};

const STATUS_CLASS: Record<QueuedPhoto['status'], string> = {
  QUEUED: 'bg-slate-100 text-slate-600',
  PREPARING: 'bg-sky-100 text-sky-800',
  UPLOADING: 'bg-sky-100 text-sky-800',
  UPLOADED: 'bg-emerald-100 text-emerald-800',
  FAILED: 'bg-rose-100 text-rose-800',
};

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

export function RoomCapture({
  api,
  tenancyId,
  roomId,
  roomLabel,
  phase,
  serverPhotoCount,
  onUploaded,
  className,
}: RoomCaptureProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [photos, setPhotos] = useState<readonly QueuedPhoto[]>([]);
  const [busy, setBusy] = useState(false);

  const queue = useMemo(
    () =>
      new UploadQueue({
        api,
        tenancyId,
        phase,
        roomId,
        onChange: setPhotos,
        createObjectUrl: (blob) => URL.createObjectURL(blob),
        revokeObjectUrl: (url) => URL.revokeObjectURL(url),
      }),
    [api, tenancyId, phase, roomId],
  );

  useEffect(() => () => queue.dispose(), [queue]);

  /**
   * Runs one queue operation and reports what *it* landed.
   *
   * `queue.uploadedCount` is deliberately not used here: it is cumulative for
   * the life of the queue, and this callback means "new since the last time I
   * told you".
   */
  const runBatch = useCallback(
    async (work: () => Promise<number>) => {
      setBusy(true);
      let landed = 0;
      try {
        landed = await work();
      } finally {
        setBusy(false);
        onUploaded?.(landed);
      }
    },
    [onUploaded],
  );

  const handleSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const selected = Array.from(event.target.files ?? []);
      // Resetting the input means the same photo can be picked twice, which
      // matters when a tenant retakes a shot of the same corner.
      event.target.value = '';
      if (selected.length === 0) return;
      await runBatch(() => queue.add(selected));
    },
    [queue, runBatch],
  );

  const failed = photos.filter((p) => p.status === 'FAILED');
  const sent = photos.filter((p) => p.status === 'UPLOADED').length;

  return (
    <section className={className} aria-labelledby={`${inputId}-heading`}>
      <header className="flex items-baseline justify-between gap-3">
        <h2 id={`${inputId}-heading`} className="text-base font-semibold text-slate-900">
          {roomLabel}
        </h2>
        <span className="text-xs text-slate-500">
          {phase === 'MOVEIN' ? 'Move-in' : 'Move-out'}
        </span>
      </header>

      {/*
        The server's count, labelled as the server's count. A client-side tally
        of what it *thinks* it uploaded is exactly the "done" that risk R5 is
        about.
      */}
      <p className="mt-1 text-sm text-slate-600" data-testid="server-count">
        {serverPhotoCount === undefined
          ? 'Checking what has been recorded…'
          : serverPhotoCount === 0
            ? 'No photographs recorded for this room yet.'
            : `${serverPhotoCount} ${
                serverPhotoCount === 1 ? 'photograph' : 'photographs'
              } recorded for this room.`}
      </p>

      <label
        htmlFor={inputId}
        className="mt-3 flex min-h-[3rem] w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-3 text-center text-sm font-semibold text-white active:bg-slate-700"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
          <path d="M9 3 7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9Zm3 5.5a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />
        </svg>
        Take photographs
      </label>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        onChange={handleSelect}
        data-testid="capture-input"
        className="sr-only"
      />

      <p className="mt-2 text-xs text-slate-500">
        Photographs are resized to {MAX_EDGE_PX}px on this device before they are sent, so
        capture works on a weak connection. The full-size original is not kept.
      </p>

      {busy ? (
        <p role="status" className="mt-2 text-xs text-sky-700" data-testid="busy">
          Sending photographs…
        </p>
      ) : null}

      {photos.length > 0 ? (
        <>
          <div className="mt-4 flex items-baseline justify-between">
            <h3 className="text-sm font-medium text-slate-700">
              This session: {sent} of {photos.length} sent
            </h3>
            {failed.length > 0 ? (
              <button
                type="button"
                onClick={() => runBatch(() => queue.retryAll())}
                disabled={busy}
                className="rounded border border-rose-300 px-2 py-1 text-xs font-medium text-rose-700 disabled:opacity-50"
              >
                Retry all {failed.length}
              </button>
            ) : null}
          </div>

          {/*
            One row per photograph, each with its own state and its own retry.
            Never a single bar: a tenant needs to know *which* photograph did
            not make it, while they are still standing in the room.
          */}
          <ul className="mt-2 divide-y divide-slate-200 rounded-lg border border-slate-200">
            {photos.map((photo) => (
              <li
                key={photo.clientRef}
                data-testid={`photo-${photo.clientRef}`}
                className="flex items-center gap-3 px-3 py-2"
              >
                {photo.previewUrl ? (
                  <img
                    src={photo.previewUrl}
                    alt=""
                    className="h-10 w-10 flex-none rounded object-cover"
                  />
                ) : (
                  <span className="h-10 w-10 flex-none rounded bg-slate-100" />
                )}

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-slate-800">
                    {photo.fileName}
                  </span>
                  <span className="block text-xs text-slate-500">
                    {photo.bytes !== undefined ? formatBytes(photo.bytes) : '—'}
                    {photo.width && photo.height ? ` · ${photo.width}×${photo.height}` : ''}
                    {photo.status === 'FAILED' && photo.error ? ` · ${photo.error}` : ''}
                  </span>
                </span>

                <span
                  data-testid={`status-${photo.clientRef}`}
                  className={`flex-none rounded px-2 py-0.5 text-xs font-medium ${
                    STATUS_CLASS[photo.status]
                  }`}
                >
                  {STATUS_COPY[photo.status]}
                </span>

                {photo.status === 'FAILED' ? (
                  <button
                    type="button"
                    onClick={() => runBatch(() => queue.retry(photo.clientRef))}
                    disabled={busy}
                    className="flex-none rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 disabled:opacity-50"
                  >
                    Retry
                  </button>
                ) : null}
              </li>
            ))}
          </ul>

          {sent > 0 ? (
            <p className="mt-2 text-xs text-slate-500" data-testid="ingest-note">
              Sent photographs are still being recorded. The count above updates once each
              one has been hashed and timestamped.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
