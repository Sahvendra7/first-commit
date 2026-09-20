import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Phase } from '@handover/shared';
import type { HandoverApiClient } from '../../lib/api-client.js';
import { MAX_EDGE_PX } from '../../lib/image-resize.js';
import { UploadQueue, type QueuedPhoto } from '../../lib/upload-queue.js';
import { Badge, Button, VerifiedGlyph } from '../../ui/index.js';

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
 *
 * ── The shape of the screen ─────────────────────────────────────────────────
 *
 * Room, then what to photograph, then one large control, then what has been
 * recorded — in that order, because this is the one screen used standing up in
 * an empty flat with one hand. The capture control is a full-width target with
 * a camera on it and nothing competing for the same tap, and the phase changes
 * the instruction above it: at move-out the whole job is *take the same views
 * again*, which is not obvious unless it is said.
 *
 * None of the copy here mentions S3, a presigned POST or a Lambda. The tenant
 * needs to know their photographs are recorded and what is still in flight;
 * the transport is the transport's business.
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

/** Tone per state. `UPLOADED` is `ok`, never "recorded" — see the header. */
const STATUS_TONE: Record<QueuedPhoto['status'], 'neutral' | 'brand' | 'ok' | 'danger'> = {
  QUEUED: 'neutral',
  PREPARING: 'brand',
  UPLOADING: 'brand',
  UPLOADED: 'ok',
  FAILED: 'danger',
};

/** What to point the camera at, which is different in each phase. */
const GUIDANCE: Record<Phase, string> = {
  MOVEIN:
    'Photograph each wall, the floor, and anything already marked or damaged. Stand in the same spot for each view — you will repeat these shots at move-out.',
  MOVEOUT:
    'Take the same views again, from the same spots you used at move-in. Like-for-like pairs are what make the comparison mean anything.',
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
    <section
      className={[
        'rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-labelledby={`${inputId}-heading`}
    >
      <header>
        <p className="text-micro font-semibold uppercase text-ink-3">Capture</p>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h2 id={`${inputId}-heading`} className="text-heading font-semibold text-ink">
            {roomLabel}
          </h2>
          <span className="text-sm text-ink-3">
            {phase === 'MOVEIN' ? 'Move-in' : 'Move-out'}
          </span>
        </div>
      </header>

      <p className="mt-2 text-sm leading-relaxed text-ink-2">{GUIDANCE[phase]}</p>

      {/*
        The one control on this panel. Full width, 56px tall, and a `<label>`
        rather than a button because the input underneath is what opens the
        camera — wrapping it in a button would need JS to forward the click and
        would lose the native file picker on every browser that does not
        support `capture`.
      */}
      <label
        htmlFor={inputId}
        className="mt-4 flex min-h-[3.5rem] w-full cursor-pointer items-center justify-center gap-2.5 rounded-xl bg-brand px-4 py-3 text-center text-[0.9375rem] font-semibold text-white shadow-sm transition-colors duration-[var(--dur-1)] hover:bg-brand-hi active:translate-y-px"
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

      {/*
        The server's count, labelled as the server's count. A client-side tally
        of what it *thinks* it uploaded is exactly the "done" that risk R5 is
        about — so this line, and only this line, gets the verification mark.
      */}
      <p
        className="mt-4 flex items-start gap-2 text-sm font-medium text-ink"
        data-testid="server-count"
      >
        <VerifiedGlyph
          className={`mt-0.5 h-4 w-4 shrink-0 ${
            serverPhotoCount ? 'text-ok' : 'text-ink-4'
          }`}
        />
        {serverPhotoCount === undefined
          ? 'Checking what has been recorded…'
          : serverPhotoCount === 0
            ? 'No photographs recorded for this room yet.'
            : `${serverPhotoCount} ${
                serverPhotoCount === 1 ? 'photograph' : 'photographs'
              } recorded for this room.`}
      </p>

      <p className="mt-2 text-xs leading-relaxed text-ink-3">
        Photographs are resized to {MAX_EDGE_PX}px on this device before they are sent, so
        capture works on a weak connection. The full-size original is not kept.
      </p>

      {busy ? (
        <p
          role="status"
          className="mt-3 inline-flex items-center gap-2 text-xs font-medium text-brand"
          data-testid="busy"
        >
          <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
          Sending photographs…
        </p>
      ) : null}

      {photos.length > 0 ? (
        <>
          <div className="mt-5 flex items-center justify-between gap-3 border-t border-line pt-4">
            <h3 className="tnum text-sm font-semibold text-ink">
              This session: {sent} of {photos.length} sent
            </h3>
            {failed.length > 0 ? (
              <Button
                tone="danger"
                size="sm"
                onClick={() => runBatch(() => queue.retryAll())}
                disabled={busy}
              >
                Retry all {failed.length}
              </Button>
            ) : null}
          </div>

          {/*
            One row per photograph, each with its own state and its own retry.
            Never a single bar: a tenant needs to know *which* photograph did
            not make it, while they are still standing in the room.
          */}
          <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line">
            {photos.map((photo) => (
              <li
                key={photo.clientRef}
                data-testid={`photo-${photo.clientRef}`}
                className="flex items-center gap-3 bg-surface px-3 py-2.5"
              >
                {photo.previewUrl ? (
                  <img
                    src={photo.previewUrl}
                    alt=""
                    className="h-11 w-11 flex-none rounded-lg object-cover ring-1 ring-line"
                  />
                ) : (
                  <span className="h-11 w-11 flex-none rounded-lg bg-paper-deep" />
                )}

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">
                    {photo.fileName}
                  </span>
                  <span className="tnum block text-xs text-ink-3">
                    {photo.bytes !== undefined ? formatBytes(photo.bytes) : '—'}
                    {photo.width && photo.height ? ` · ${photo.width}×${photo.height}` : ''}
                    {photo.status === 'FAILED' && photo.error ? ` · ${photo.error}` : ''}
                  </span>
                </span>

                <Badge
                  tone={STATUS_TONE[photo.status]}
                  dot={photo.status === 'PREPARING' || photo.status === 'UPLOADING'}
                  caps={false}
                  className="flex-none"
                  data-testid={`status-${photo.clientRef}`}
                >
                  {STATUS_COPY[photo.status]}
                </Badge>

                {photo.status === 'FAILED' ? (
                  <Button
                    tone="secondary"
                    size="sm"
                    className="flex-none"
                    onClick={() => runBatch(() => queue.retry(photo.clientRef))}
                    disabled={busy}
                  >
                    Retry
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>

          {sent > 0 ? (
            <p className="mt-3 text-xs leading-relaxed text-ink-3" data-testid="ingest-note">
              Sent photographs are still being recorded. The count above updates once each
              one has been hashed and timestamped.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
