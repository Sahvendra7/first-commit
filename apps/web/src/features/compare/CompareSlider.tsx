import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { Banner, EvidenceMeta } from '../../ui/index.js';
import {
  boxToPercentStyle,
  clamp01,
  containRect,
  pointFromClient,
  projectBoxToFrame,
  type NormalizedBox,
} from '../../lib/geometry.js';

/**
 * The post-capture compare slider (§5.1, §12).
 *
 * §12 records why this exists: `<input capture="environment">` was chosen over
 * `getUserMedia`, which **loses the live ghost overlay**. This component is the
 * replacement — "a post-capture compare slider — deliberate risk reduction for
 * a team new to camera APIs".
 *
 * Three things it has to get right:
 *
 * 1. **Differing aspect ratios.** A move-in photo and a move-out photo of the
 *    same room are routinely not the same shape. Both are letterboxed inside
 *    one shared frame with `object-fit: contain`, so neither is stretched and
 *    the divider cuts a single rectangle. The frame takes the *after* photo's
 *    aspect by default, because that is the image changes are marked against.
 * 2. **Touch and mouse.** Pointer events cover mouse, touch and stylus in one
 *    code path, with pointer capture so a finger that slides off the image
 *    keeps dragging. `touch-action: none` stops the page scrolling underneath.
 * 3. **Keyboard.** It is a `role="slider"`; arrows, Home and End move it. Not
 *    decoration — a drag-only control is unusable for anyone who cannot drag.
 *
 * ── Side by side ────────────────────────────────────────────────────────────
 *
 * The slider is the default because it is the only view that puts the two
 * photographs in the *same* pixels, which is what makes a small difference
 * visible at all. But it shows half of each at a time, and some comparisons —
 * "is this the same wall?" — want both whole. So there is a second view, and
 * it is a genuine toggle rather than a breakpoint: on a phone the two stack,
 * which is still both-whole and still useful.
 */

/** One image in the pair. `alt` is required — this is evidence, not chrome. */
export interface ComparePhoto {
  readonly url: string;
  readonly alt: string;
  /**
   * Intrinsic aspect ratio (w / h), if already known. Omit it and the
   * component measures the photo on load; until then it renders against
   * `fallbackAspect` rather than jumping.
   */
  readonly aspect?: number;
  /**
   * `PhotoRef.receivedAt` — the **server** clock, which is what the ledger
   * attests to. Not `exifCapturedAt`, which is device-reported and is not
   * trusted as authoritative.
   */
  readonly receivedAt?: string;
  /**
   * `PhotoRef.sha256`. Rendered truncated beneath the frame. This is a
   * feature, not clutter: the tamper-evidence is the product.
   */
  readonly sha256?: string;
}

/**
 * A labelled box to draw over the after-image. Coordinates are normalised
 * against the **after photograph**, not the frame — the component projects
 * them into frame space itself, which is what keeps an overlay aligned when
 * the two photos are different shapes.
 */
export interface CompareOverlayBox {
  readonly id: string;
  readonly box: NormalizedBox;
  readonly label: string;
  /** Dims the box. Used for changes the tenant has rejected. */
  readonly muted?: boolean;
}

export interface CompareSliderProps {
  readonly before: ComparePhoto;
  readonly after: ComparePhoto;
  /** Controlled divider position, 0–1. Omit for uncontrolled. */
  readonly position?: number;
  readonly defaultPosition?: number;
  readonly onPositionChange?: (position: number) => void;
  /** Labelled boxes over the after-image. §5.1 "change overlay". */
  readonly overlays?: readonly CompareOverlayBox[];
  /** Frame aspect when neither photo has reported one yet. */
  readonly fallbackAspect?: number;
  /** Keyboard step, as a fraction of the width. */
  readonly step?: number;
  readonly beforeLabel?: string;
  readonly afterLabel?: string;
  /**
   * The surface this sits on.
   *
   * `night` is the room screen's comparison stage: a dark panel, so the
   * photograph is the only lit thing on the screen and the chrome around it
   * recedes rather than competing. Everything about the control is the same in
   * both tones — only the ink of the frame around it changes.
   */
  readonly tone?: 'paper' | 'night';
  readonly className?: string;
  /**
   * Presigned photo URLs expire in five minutes and a review session outlasts
   * that. The component surfaces the failure rather than showing a broken
   * image, and calls this so the caller can re-fetch the aggregate.
   */
  readonly onImageError?: (which: 'before' | 'after') => void;
}

const DEFAULT_FALLBACK_ASPECT = 4 / 3;

/** Which of the two views is on. The slider is the default; see the header. */
type CompareView = 'SLIDER' | 'SIDE_BY_SIDE';

export function CompareSlider({
  before,
  after,
  position,
  defaultPosition = 0.5,
  onPositionChange,
  overlays,
  fallbackAspect = DEFAULT_FALLBACK_ASPECT,
  step = 0.02,
  beforeLabel = 'Move-in',
  afterLabel = 'Move-out',
  tone = 'paper',
  className,
  onImageError,
}: CompareSliderProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const labelId = useId();

  const [uncontrolled, setUncontrolled] = useState(() => clamp01(defaultPosition));
  const [dragging, setDragging] = useState(false);
  const [view, setView] = useState<CompareView>('SLIDER');

  // Measured on load, so a caller that does not know the intrinsic size of a
  // presigned photo (PhotoRef carries no dimensions) still gets a correct frame.
  const [measuredBefore, setMeasuredBefore] = useState<number>();
  const [measuredAfter, setMeasuredAfter] = useState<number>();
  const [failed, setFailed] = useState<{ before: boolean; after: boolean }>({
    before: false,
    after: false,
  });

  const handleImageError = useCallback(
    (which: 'before' | 'after') => {
      setFailed((prev) => (prev[which] ? prev : { ...prev, [which]: true }));
      onImageError?.(which);
    },
    [onImageError],
  );

  const isControlled = position !== undefined;
  const value = clamp01(isControlled ? position : uncontrolled);

  const commit = useCallback(
    (next: number) => {
      const clamped = clamp01(next);
      if (!isControlled) setUncontrolled(clamped);
      onPositionChange?.(clamped);
    },
    [isControlled, onPositionChange],
  );

  const beforeAspect = before.aspect ?? measuredBefore;
  const afterAspect = after.aspect ?? measuredAfter;
  // The after photo owns the frame: overlays are in its coordinate space, so
  // giving it the frame keeps marked changes as large and as square-on as
  // possible. Before-only is the fallback while the after photo is loading.
  const frameAspect = afterAspect ?? beforeAspect ?? fallbackAspect;

  const beforeContent = useMemo(
    () => containRect(beforeAspect ?? frameAspect, frameAspect),
    [beforeAspect, frameAspect],
  );
  const afterContent = useMemo(
    () => containRect(afterAspect ?? frameAspect, frameAspect),
    [afterAspect, frameAspect],
  );

  const positionFromEvent = useCallback((clientX: number): number => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return pointFromClient(clientX, 0, rect).x;
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Secondary buttons would start a drag the user cannot see the end of.
      if (event.button !== 0 && event.pointerType === 'mouse') return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setDragging(true);
      commit(positionFromEvent(event.clientX));
    },
    [commit, positionFromEvent],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      // Keeps the page from scrolling out from under a finger mid-drag.
      event.preventDefault();
      commit(positionFromEvent(event.clientX));
    },
    [commit, dragging, positionFromEvent],
  );

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setDragging(false);
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const jump = event.shiftKey ? step * 5 : step;
      let next: number | undefined;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = value - jump;
      else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = value + jump;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = 1;
      if (next === undefined) return;
      event.preventDefault();
      commit(next);
    },
    [commit, step, value],
  );

  const pct = (value * 100).toFixed(4);

  const showBoth = view === 'SIDE_BY_SIDE';
  const night = tone === 'night';

  return (
    <div className={className}>
      {/*
        A two-state segmented control rather than a checkbox: the two views are
        alternatives, not a setting, and `aria-pressed` on a pair of buttons is
        what says so without inventing a widget role.
      */}
      <div
        role="group"
        aria-label="Comparison view"
        className={`mb-3 inline-flex rounded-xl border p-1 ${
          night ? 'border-white/12 bg-white/[0.06]' : 'border-line bg-surface shadow-xs'
        }`}
      >
        {(
          [
            ['SLIDER', 'Slider'],
            ['SIDE_BY_SIDE', 'Side by side'],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            aria-pressed={view === mode}
            onClick={() => setView(mode)}
            data-testid={`compare-view-${mode.toLowerCase()}`}
            className={`min-h-9 rounded-lg px-3 text-xs font-semibold transition-colors duration-[var(--dur-1)] ${
              view === mode
                ? night
                  ? 'bg-white text-night'
                  : 'bg-brand text-white'
                : night
                  ? 'text-white/65 hover:bg-white/10 hover:text-white'
                  : 'text-ink-2 hover:bg-sunk'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {showBoth ? (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="compare-side-by-side">
          <StillFrame
            label={beforeLabel}
            photo={before}
            aspect={frameAspect}
            onMeasured={setMeasuredBefore}
            onError={() => handleImageError('before')}
          />
          <StillFrame
            label={afterLabel}
            photo={after}
            aspect={frameAspect}
            onMeasured={setMeasuredAfter}
            onError={() => handleImageError('after')}
            overlays={overlays ?? []}
            content={afterContent}
          />
        </div>
      ) : (
      <div
        ref={frameRef}
        role="slider"
        tabIndex={0}
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value * 100)}
        aria-valuetext={`${Math.round(value * 100)}% ${beforeLabel}`}
        aria-orientation="horizontal"
        data-testid="compare-frame"
        data-dragging={dragging ? 'true' : 'false'}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKeyDown}
        className={[
          'group/frame relative w-full select-none overflow-hidden rounded-2xl bg-night outline-none',
          // `grab`/`grabbing` rather than `ew-resize`: the handle is an object
          // being moved, not an edge being resized, and the cursor is the
          // cheapest way to say which.
          dragging ? 'cursor-grabbing' : 'cursor-grab',
          'ring-offset-2 focus-visible:ring-2 focus-visible:ring-brand-hi',
          night
            ? 'shadow-frame ring-1 ring-white/10 ring-offset-night'
            : 'shadow-md ring-offset-paper',
        ].join(' ')}
        style={{ aspectRatio: String(frameAspect), touchAction: 'none' }}
      >
        {/*
          Base layer: the after photo. The before photo is the overlay, clipped
          to the left of the divider, so the frame reads left-to-right as
          "how it was" -> "how it is".
        */}
        <img
          src={after.url}
          alt={after.alt}
          draggable={false}
          onLoad={(e) => {
            const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
            if (w > 0 && h > 0) setMeasuredAfter(w / h);
          }}
          onError={() => handleImageError('after')}
          className="pointer-events-none absolute inset-0 h-full w-full object-contain"
        />

        {/*
          Overlay boxes ride on the after photo and are therefore occluded by
          the before photo on the left of the divider. That is deliberate: a
          marked change is an assertion about the after photograph, and showing
          it floating over the move-in image would misrepresent it.
        */}
        {overlays?.map((overlay) => {
          const framed = projectBoxToFrame(overlay.box, afterContent);
          const style = boxToPercentStyle(framed);
          return (
            <div
              key={overlay.id}
              data-testid={`overlay-${overlay.id}`}
              className={`pointer-events-none absolute rounded-sm border-2 ${
                overlay.muted ? 'border-ink-4/70' : 'border-accent'
              }`}
              style={style}
            >
              <span
                className={`absolute left-0 top-full mt-1 max-w-[12rem] truncate rounded-md px-1.5 py-0.5 text-[10px] font-semibold leading-tight ${
                  overlay.muted ? 'bg-ink-3/85 text-white' : 'bg-accent text-white'
                }`}
              >
                {overlay.label}
              </span>
            </div>
          );
        })}

        <div
          className="absolute inset-0 overflow-hidden"
          style={{ clipPath: `inset(0 ${(100 - Number(pct)).toFixed(4)}% 0 0)` }}
          data-testid="compare-before-clip"
        >
          <img
            src={before.url}
            alt={before.alt}
            draggable={false}
            onLoad={(e) => {
              const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
              if (w > 0 && h > 0) setMeasuredBefore(w / h);
            }}
            onError={() => handleImageError('before')}
            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
          />
        </div>

        {/* The divider and its grab handle. */}
        <div
          aria-hidden="true"
          data-testid="compare-divider"
          className="pointer-events-none absolute inset-y-0 w-px bg-white/90 shadow-[0_0_0_1px_rgb(var(--c-night)/0.45)]"
          style={{ left: `${pct}%` }}
        >
          {/*
            The handle grows a little under the finger and settles back. It is
            the one place in the app where the interaction is the product, so
            it is worth the two transforms — and `prefers-reduced-motion`
            collapses the transition globally, leaving the size change without
            the travel.
          */}
          <div
            className={[
              'absolute left-1/2 top-1/2 flex h-12 w-12 -translate-x-1/2 -translate-y-1/2',
              'items-center justify-center rounded-full bg-white ring-1 ring-night/10',
              'transition-[box-shadow,scale] duration-[var(--dur-2)] ease-[var(--ease)]',
              dragging ? 'scale-110 shadow-lg' : 'scale-100 shadow-md group-hover/frame:scale-105',
            ].join(' ')}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5 text-brand" fill="currentColor">
              <path d="M9.5 6 5 12l4.5 6V6Zm5 0v12l4.5-6-4.5-6Z" />
            </svg>
          </div>
        </div>

        <PhaseChip className="left-3 top-3">{beforeLabel}</PhaseChip>
        <PhaseChip className="right-3 top-3">{afterLabel}</PhaseChip>
      </div>
      )}

      {failed.before || failed.after ? (
        <Banner role="status" tone="warn" className="mt-3" data-testid="photo-expired">
          A photograph could not be loaded. Secure photo links expire after five minutes —
          reload this page to refresh them.
        </Banner>
      ) : null}

      <p id={labelId} className={`mt-3 text-xs ${night ? 'text-white/55' : 'text-ink-3'}`}>
        {showBoth
          ? `${beforeLabel} and ${afterLabel}, side by side. Switch to the slider to see the two in the same frame.`
          : `Drag to compare ${beforeLabel.toLowerCase()} with ${afterLabel.toLowerCase()}. Use the arrow keys for fine control.`}
      </p>

      {/*
        The tamper-evidence is the product, so the digest and the timestamp sit
        under the photographs rather than behind a details panel. `receivedAt`
        is the server clock — the instant the record attests to.
      */}
      {before.sha256 ?? after.sha256 ?? before.receivedAt ?? after.receivedAt ? (
        <div
          data-testid="evidence-meta"
          className={
            night
              ? 'mt-4 grid grid-cols-2 gap-4 border-t border-white/10 pt-4'
              : 'mt-3 grid grid-cols-2 gap-3 rounded-xl border border-line bg-sunk p-3'
          }
        >
          <EvidenceMeta
            label={beforeLabel}
            tone={tone}
            {...(before.receivedAt ? { receivedAt: before.receivedAt } : {})}
            {...(before.sha256 ? { sha256: before.sha256 } : {})}
          />
          <EvidenceMeta
            label={afterLabel}
            tone={tone}
            {...(after.receivedAt ? { receivedAt: after.receivedAt } : {})}
            {...(after.sha256 ? { sha256: after.sha256 } : {})}
          />
        </div>
      ) : null}

      {/*
        Letterbox reconciliation is invisible until the two photos disagree, so
        it is stated rather than left for the tenant to wonder about.
      */}
      {beforeAspect !== undefined &&
      afterAspect !== undefined &&
      Math.abs(beforeAspect - afterAspect) > 0.01 ? (
        <p
          className={`mt-2.5 text-[0.6875rem] leading-relaxed ${night ? 'text-white/40' : 'text-ink-3'}`}
          data-testid="aspect-mismatch-note"
        >
          These photographs were taken at different aspect ratios, so both are shown
          letterboxed inside the same frame. Neither image has been cropped or stretched.
        </p>
      ) : null}

      {beforeContent.w < 1 || beforeContent.h < 1 ? (
        <span className="sr-only" data-testid="before-letterboxed">
          Move-in photograph is letterboxed to fit the comparison frame.
        </span>
      ) : null}
    </div>
  );
}

/** The phase marker that sits on a photograph. One shape, both views. */
function PhaseChip({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <span
      className={[
        'pointer-events-none absolute rounded-full bg-night/75 px-2.5 py-1',
        'text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-white backdrop-blur-sm',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </span>
  );
}

/**
 * One whole photograph, for the side-by-side view.
 *
 * It shares the slider's frame aspect rather than taking its own, so the two
 * panels are the same size and the eye can move between them without
 * re-anchoring — which is the entire point of looking at them side by side.
 */
function StillFrame({
  label,
  photo,
  aspect,
  onMeasured,
  onError,
  overlays,
  content,
}: {
  readonly label: string;
  readonly photo: ComparePhoto;
  readonly aspect: number;
  readonly onMeasured: (aspect: number) => void;
  readonly onError: () => void;
  readonly overlays?: readonly CompareOverlayBox[];
  /** The letterboxed rect this photo occupies in the frame, from `containRect`. */
  readonly content?: NormalizedBox;
}) {
  return (
    <figure
      className="relative overflow-hidden rounded-2xl bg-night shadow-md"
      style={{ aspectRatio: String(aspect) }}
    >
      <img
        src={photo.url}
        alt={photo.alt}
        draggable={false}
        onLoad={(e) => {
          const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
          if (w > 0 && h > 0) onMeasured(w / h);
        }}
        onError={onError}
        className="absolute inset-0 h-full w-full object-contain"
      />
      {content
        ? overlays?.map((overlay) => (
            <div
              key={overlay.id}
              className={`pointer-events-none absolute rounded-sm border-2 ${
                overlay.muted ? 'border-ink-4/70' : 'border-accent'
              }`}
              style={boxToPercentStyle(projectBoxToFrame(overlay.box, content))}
            />
          ))
        : null}
      <PhaseChip className="left-3 top-3">{label}</PhaseChip>
    </figure>
  );
}
