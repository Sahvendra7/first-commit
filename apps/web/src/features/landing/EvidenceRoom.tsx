import { useEffect, useRef, useState } from 'react';

/**
 * The brand visual: an abstract room in perspective, holding the same view
 * recorded twice.
 *
 * ── Why this is CSS and not WebGL ───────────────────────────────────────────
 *
 * The brief permits Three.js "ONLY if the visual genuinely benefits from it".
 * This one does not. It is five planes, two frames and a rule: CSS 3D
 * transforms draw it with no dependency, no shader compile, no canvas, nothing
 * to lazy-load and nothing to fall back *from* — there is no WebGL context that
 * can fail here, so the "non-WebGL fallback" the brief asks for is the whole
 * implementation. It adds zero bytes to `package.json` and is composited on the
 * GPU as a handful of layers, which is well inside a budget phone's means.
 *
 * Browsers without `transform-style: preserve-3d` (none current) flatten it
 * into a stacked composition that still reads correctly, because the z-order
 * and the 2D offsets alone carry the picture.
 *
 * ── What it is trying to say ────────────────────────────────────────────────
 *
 * Property, evidence, time, verification — in that order of prominence. The
 * room is the setting and is drawn faintly; the two frames are the subject; the
 * seal between them is the claim the product makes. The frames hold abstract
 * room geometry rather than photographs, because a stock interior photo here
 * would be decoration, and a *fixture* photo would imply the landing page is
 * showing someone's evidence.
 *
 * ── Motion ──────────────────────────────────────────────────────────────────
 *
 * A slow parallax tied to the pointer, and nothing else. No autoplay, no loop,
 * no particles. It is off entirely under `prefers-reduced-motion`, and on
 * touch devices, where there is no hovering pointer to tie it to and a
 * scroll-driven version would fight the thumb. The idle pose is the designed
 * pose; parallax only leans it a few degrees either side.
 */

/** Degrees of lean at the extremes of the pointer's travel. */
const TILT_X = 4;
const TILT_Y = 7;

export interface EvidenceRoomProps {
  readonly className?: string;
}

export function EvidenceRoom({ className }: EvidenceRoomProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [lean, setLean] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof globalThis.matchMedia !== 'function') return;

    const fine = globalThis.matchMedia('(hover: hover) and (pointer: fine)');
    const still = globalThis.matchMedia('(prefers-reduced-motion: reduce)');
    if (!fine.matches || still.matches) return;

    let frame = 0;
    const onMove = (event: PointerEvent) => {
      if (frame) return;
      // One update per painted frame. A pointermove handler that sets state on
      // every event will happily fire 200 times a second on a high-rate mouse.
      frame = requestAnimationFrame(() => {
        frame = 0;
        const rect = host.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const nx = (event.clientX - rect.left) / rect.width - 0.5;
        const ny = (event.clientY - rect.top) / rect.height - 0.5;
        setLean({ x: nx, y: ny });
      });
    };
    const onLeave = () => setLean({ x: 0, y: 0 });

    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerleave', onLeave);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className={['relative select-none', className ?? ''].join(' ')}
      // Decorative: the hero's heading and body already say all of this in
      // words, so announcing it again would be noise.
      aria-hidden="true"
      data-testid="evidence-room"
    >
      <div
        className="relative mx-auto aspect-[5/4] w-full max-w-[34rem] sm:aspect-[4/3]"
        style={{ perspective: '1150px', perspectiveOrigin: '52% 46%' }}
      >
        <div
          className="absolute inset-0 transition-transform duration-[600ms] ease-[var(--ease)]"
          style={{
            transformStyle: 'preserve-3d',
            transform: `rotateX(${(-lean.y * TILT_X).toFixed(2)}deg) rotateY(${(lean.x * TILT_Y).toFixed(2)}deg)`,
          }}
        >
          <RoomShell />

          {/* MOVE-IN — set back, dashed: the record as it was. */}
          <FloatingFrame
            label="Move-in"
            caption="02 Sep"
            dashed
            box="left-[2%] top-[12%] w-[52%]"
            depth="translateZ(-40px) rotateY(13deg) rotateX(2deg)"
          >
            <RoomSketch />
          </FloatingFrame>

          {/* MOVE-OUT — nearer, solid, carrying a mark: the same view, later. */}
          <FloatingFrame
            label="Move-out"
            caption="15 Sep"
            box="left-[38%] top-[38%] w-[56%]"
            depth="translateZ(95px) rotateY(-8deg) rotateX(-1deg)"
          >
            <RoomSketch marked />
          </FloatingFrame>

          {/*
            The seal sits exactly where the two frames overlap, because that
            corner is the product's whole claim: not two photographs, but two
            photographs held against each other.
          */}
          <span
            className="absolute left-[37%] top-[56%] flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/30 bg-night/90 shadow-frame backdrop-blur-sm"
            style={{ transform: 'translate(-50%, -50%) translateZ(140px)' }}
          >
            <svg viewBox="0 0 16 16" className="h-5 w-5 text-white" fill="none">
              <path
                d="M8 1.2 13.6 3.4v4.2c0 3.2-2.2 6-5.6 7.2-3.4-1.2-5.6-4-5.6-7.2V3.4L8 1.2Z"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
              <path
                d="m5.6 8 1.7 1.7 3.1-3.4"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </div>
      </div>

      <TimeAxis />
    </div>
  );
}

/**
 * Floor and back wall: enough geometry to read as a room, and no more. Both
 * are held well behind the frames in Z so they never compete with the subject.
 */
function RoomShell() {
  return (
    <>
      {/*
        The back wall carries no border. With one it read as a stray card
        floating behind the frames rather than as a surface; a masked wash is
        enough to say "there is a room back there" and nothing more.
      */}
      <div
        className="absolute left-[10%] top-[4%] h-[54%] w-[76%] bg-gradient-to-b from-white/[0.05] to-transparent"
        style={{
          transform: 'translateZ(-230px)',
          maskImage: 'radial-gradient(ellipse at 50% 40%, rgb(0 0 0) 30%, transparent 78%)',
          WebkitMaskImage: 'radial-gradient(ellipse at 50% 40%, rgb(0 0 0) 30%, transparent 78%)',
        }}
      />
      <div
        className="absolute bottom-[4%] left-[4%] h-[52%] w-[92%] border-t border-white/[0.10]"
        style={{
          transform: 'rotateX(76deg)',
          transformOrigin: 'center top',
          backgroundImage:
            'linear-gradient(to right, rgb(255 255 255 / 0.05) 1px, transparent 1px),' +
            'linear-gradient(to bottom, rgb(255 255 255 / 0.05) 1px, transparent 1px),' +
            'radial-gradient(ellipse at 50% 0%, rgb(var(--c-brand-line) / 0.10), transparent 60%)',
          backgroundSize: '40px 40px, 40px 40px, 100% 100%',
          maskImage: 'linear-gradient(to bottom, rgb(0 0 0) 6%, transparent 82%)',
          WebkitMaskImage: 'linear-gradient(to bottom, rgb(0 0 0) 6%, transparent 82%)',
        }}
      />
    </>
  );
}

interface FloatingFrameProps {
  readonly label: string;
  readonly caption: string;
  readonly dashed?: boolean;
  /** Placement in the scene, as Tailwind position utilities. */
  readonly box: string;
  /** Depth and rotation. Kept separate so placement stays readable. */
  readonly depth: string;
  readonly children: React.ReactNode;
}

/**
 * One frame.
 *
 * The label sits *inside* the frame rather than under it. Captions below were
 * the first thing to be clipped at the scene's edge and the first thing the
 * nearer frame occluded — and a label a reader cannot finish is worse than no
 * label at all.
 */
function FloatingFrame({ label, caption, dashed, box, depth, children }: FloatingFrameProps) {
  return (
    <figure className={['absolute', box].join(' ')} style={{ transform: depth }}>
      <div
        className={[
          'relative overflow-hidden rounded-xl bg-night shadow-frame',
          dashed ? 'border border-dashed border-white/25' : 'border border-white/50',
        ].join(' ')}
      >
        <div className="aspect-[4/3] w-full">{children}</div>
        <figcaption className="absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-gradient-to-b from-night/85 to-transparent px-2.5 py-2">
          <span
            className={[
              'rounded-full px-2 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-[0.09em]',
              dashed ? 'bg-white/10 text-white/70' : 'bg-white text-night',
            ].join(' ')}
          >
            {label}
          </span>
          <span className="text-[0.5625rem] font-medium tracking-wide text-white/50">
            {caption}
          </span>
        </figcaption>
      </div>
    </figure>
  );
}

/**
 * The third axis the room cannot show: time. A hairline with the three moments
 * the product actually spans, so the scene says *property + evidence + time*
 * rather than just *property + evidence*.
 */
function TimeAxis() {
  const marks = [
    { id: 'in', label: 'Move-in', done: true },
    { id: 'out', label: 'Move-out', done: true },
    { id: 'recovery', label: 'Recovery', done: false },
  ] as const;
  return (
    <div className="mx-auto mt-2 flex w-full max-w-[30rem] items-center px-2">
      {marks.map((mark, i) => (
        <div key={mark.id} className="flex flex-1 items-center last:flex-none">
          <div className="flex flex-col items-center gap-1.5">
            <span
              className={[
                'h-2 w-2 rounded-full',
                mark.done ? 'bg-brand-line' : 'border border-white/35 bg-transparent',
              ].join(' ')}
            />
            <span className="whitespace-nowrap text-[0.5625rem] font-semibold uppercase tracking-[0.09em] text-white/45">
              {mark.label}
            </span>
          </div>
          {i < marks.length - 1 ? (
            <span className="mb-4 h-px flex-1 bg-gradient-to-r from-brand-line/50 to-white/15" />
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * The contents of a frame: a window, a skirting line, a doorway. Abstract
 * geometry rather than a photograph — see the note at the top of the file.
 *
 * `marked` adds the ochre box the app uses everywhere for a recorded change,
 * so the pair reads as before/after without a word of caption.
 */
function RoomSketch({ marked }: { readonly marked?: boolean }) {
  return (
    <svg viewBox="0 0 160 120" className="h-full w-full" fill="none">
      <rect width="160" height="120" fill="rgb(var(--c-night-2))" />
      {/* Wall / floor split. */}
      <path d="M0 88h160" stroke="rgb(255 255 255 / 0.18)" strokeWidth="1" />
      <path d="M0 95h160" stroke="rgb(255 255 255 / 0.09)" strokeWidth="1" />
      {/* Window. */}
      <rect
        x="20"
        y="30"
        width="50"
        height="40"
        rx="2"
        stroke="rgb(255 255 255 / 0.34)"
        strokeWidth="1.3"
      />
      <path d="M45 30v40M20 50h50" stroke="rgb(255 255 255 / 0.20)" strokeWidth="1" />
      {/* Doorway. */}
      <path
        d="M114 88V36h28v52"
        stroke="rgb(255 255 255 / 0.24)"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      {/* Floor recession. */}
      <path d="M0 120 36 88M160 120l-30-32" stroke="rgb(255 255 255 / 0.11)" strokeWidth="1" />
      {marked ? (
        <>
          <rect x="82" y="56" width="26" height="22" rx="2" fill="rgb(var(--c-accent) / 0.16)" />
          <rect
            x="82"
            y="56"
            width="26"
            height="22"
            rx="2"
            stroke="rgb(var(--c-accent))"
            strokeWidth="1.7"
          />
        </>
      ) : null}
    </svg>
  );
}
