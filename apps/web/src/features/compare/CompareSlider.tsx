import { useCallback, useId, useMemo, useRef, useState } from 'react';
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
  readonly className?: string;
}

const DEFAULT_FALLBACK_ASPECT = 4 / 3;

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
  className,
}: CompareSliderProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const labelId = useId();

  const [uncontrolled, setUncontrolled] = useState(() => clamp01(defaultPosition));
  const [dragging, setDragging] = useState(false);

  // Measured on load, so a caller that does not know the intrinsic size of a
  // presigned photo (PhotoRef carries no dimensions) still gets a correct frame.
  const [measuredBefore, setMeasuredBefore] = useState<number>();
  const [measuredAfter, setMeasuredAfter] = useState<number>();

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

  return (
    <div className={className}>
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
        className="relative w-full select-none overflow-hidden rounded-lg bg-slate-900 outline-none ring-offset-2 focus-visible:ring-2 focus-visible:ring-sky-500"
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
              className={`pointer-events-none absolute border-2 ${
                overlay.muted ? 'border-slate-400/60' : 'border-amber-400'
              }`}
              style={style}
            >
              <span
                className={`absolute left-0 top-full mt-0.5 max-w-[12rem] truncate rounded px-1 py-0.5 text-[10px] font-medium leading-tight ${
                  overlay.muted ? 'bg-slate-500/80 text-white' : 'bg-amber-400 text-slate-900'
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
            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
          />
        </div>

        {/* The divider and its grab handle. */}
        <div
          aria-hidden="true"
          data-testid="compare-divider"
          className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(15,23,42,0.35)]"
          style={{ left: `${pct}%` }}
        >
          <div className="absolute left-1/2 top-1/2 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white shadow-md">
            <svg viewBox="0 0 24 24" className="h-5 w-5 text-slate-700" fill="currentColor">
              <path d="M9.5 6 5 12l4.5 6V6Zm5 0v12l4.5-6-4.5-6Z" />
            </svg>
          </div>
        </div>

        <span className="pointer-events-none absolute left-2 top-2 rounded bg-slate-900/70 px-2 py-0.5 text-xs font-medium text-white">
          {beforeLabel}
        </span>
        <span className="pointer-events-none absolute right-2 top-2 rounded bg-slate-900/70 px-2 py-0.5 text-xs font-medium text-white">
          {afterLabel}
        </span>
      </div>

      <p id={labelId} className="mt-2 text-xs text-slate-600">
        Drag to compare {beforeLabel.toLowerCase()} with {afterLabel.toLowerCase()}. Use the
        arrow keys for fine control.
      </p>

      {/*
        Letterbox reconciliation is invisible until the two photos disagree, so
        it is stated rather than left for the tenant to wonder about.
      */}
      {beforeAspect !== undefined &&
      afterAspect !== undefined &&
      Math.abs(beforeAspect - afterAspect) > 0.01 ? (
        <p className="mt-1 text-xs text-slate-500" data-testid="aspect-mismatch-note">
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
