import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { CHANGE_SURFACES, CHANGE_TYPES, type ChangeSurface, type ChangeType } from '@handover/shared';
import {
  boxFromPoints,
  boxToPercentStyle,
  containRect,
  describeBoxPosition,
  isDegenerateBox,
  pointFromClient,
  projectBoxToFrame,
  unprojectPointFromFrame,
  type NormalizedBox,
  type NormalizedPoint,
} from '../../lib/geometry.js';
import { validateMark, type MarkedChange } from '../../lib/marked-change.js';

/**
 * The tenant marks a change on the move-out photograph (web-contract §0.2).
 *
 * **The tenant is the author of the change list, not a reviewer of the
 * machine's.** This is the primary path on the review screen: it works with the
 * suggestion flag off, with Bedrock unreachable, and with an empty diff — which
 * is the default, not the degraded case.
 *
 * Two constraints shape the design:
 *
 * - **The box never reaches the API.** `diffAdditionSchema` is
 *   `{ type, surface?, location, description }`; there is no geometry field and
 *   the contract is frozen. Drawing is a way to *think* about where something
 *   is, and it positions the overlay on screen. What is sent is the prose.
 * - **Drawing is therefore optional.** A change described in words is a
 *   complete change, so there is a button that opens the same form with no box
 *   at all. Anyone who cannot drag can still author the record.
 *
 * Tenant additions carry no `confidence`: the schema has no field for one and a
 * human assertion is not a sampled one. Nothing here synthesises a value.
 */

export interface ChangeMarkerProps {
  /** The move-out photograph being marked. */
  readonly imageUrl: string;
  readonly imageAlt: string;
  /** Intrinsic aspect (w / h) if known; otherwise measured on load. */
  readonly imageAspect?: number;
  readonly marks: readonly MarkedChange[];
  readonly onMarksChange: (marks: readonly MarkedChange[]) => void;
  readonly fallbackAspect?: number;
  readonly className?: string;
  /** Injected for deterministic ids in tests. */
  readonly makeId?: () => string;
}

interface Draft {
  readonly id: string;
  readonly box?: NormalizedBox;
  readonly type: ChangeType;
  readonly surface: ChangeSurface | '';
  readonly location: string;
  readonly description: string;
  /** True when editing an existing mark rather than adding one. */
  readonly editing: boolean;
}

const DEFAULT_FALLBACK_ASPECT = 4 / 3;

/** Sentence-case a contract enum for a dropdown without a lookup table. */
function humanise(value: string): string {
  const lower = value.replace(/_/g, ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function ChangeMarker({
  imageUrl,
  imageAlt,
  imageAspect,
  marks,
  onMarksChange,
  fallbackAspect = DEFAULT_FALLBACK_ASPECT,
  className,
  makeId,
}: ChangeMarkerProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const seqRef = useRef(0);

  const [measured, setMeasured] = useState<number>();
  const [drawing, setDrawing] = useState<{ origin: NormalizedPoint; box: NormalizedBox } | null>(
    null,
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<{ location?: string; description?: string }>({});

  const frameAspect = imageAspect ?? measured ?? fallbackAspect;
  const content = useMemo(
    () => containRect(imageAspect ?? measured ?? frameAspect, frameAspect),
    [imageAspect, measured, frameAspect],
  );

  const nextId = useCallback((): string => {
    if (makeId) return makeId();
    seqRef.current += 1;
    return `${baseId}-mark-${seqRef.current}`;
  }, [baseId, makeId]);

  /** Viewport coordinate -> a point in the photograph's own coordinates. */
  const toImagePoint = useCallback(
    (clientX: number, clientY: number): NormalizedPoint => {
      const rect = frameRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return unprojectPointFromFrame(pointFromClient(clientX, clientY, rect), content);
    },
    [content],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (draft) return; // The form is open; don't start a second box behind it.
      if (event.button !== 0 && event.pointerType === 'mouse') return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const origin = toImagePoint(event.clientX, event.clientY);
      setDrawing({ origin, box: boxFromPoints(origin, origin) });
    },
    [draft, toImagePoint],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!drawing) return;
      event.preventDefault();
      const point = toImagePoint(event.clientX, event.clientY);
      setDrawing({ origin: drawing.origin, box: boxFromPoints(drawing.origin, point) });
    },
    [drawing, toImagePoint],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      if (!drawing) return;
      const { box } = drawing;
      setDrawing(null);
      // A stray tap while scrolling produces a 0x0 box. Treating that as a
      // marked change would put noise into the evidence record.
      if (isDegenerateBox(box)) return;

      setErrors({});
      setDraft({
        id: nextId(),
        box,
        type: 'OTHER',
        surface: '',
        // A suggestion seeded into an editable field, not a generated fact.
        location: describeBoxPosition(box),
        description: '',
        editing: false,
      });
    },
    [drawing, nextId],
  );

  const startUndrawn = useCallback(() => {
    setErrors({});
    setDraft({
      id: nextId(),
      type: 'OTHER',
      surface: '',
      location: '',
      description: '',
      editing: false,
    });
  }, [nextId]);

  const startEdit = useCallback((mark: MarkedChange) => {
    setErrors({});
    setDraft({
      id: mark.id,
      ...(mark.box ? { box: mark.box } : {}),
      type: mark.type,
      surface: mark.surface ?? '',
      location: mark.location,
      description: mark.description,
      editing: true,
    });
  }, []);

  const save = useCallback(() => {
    if (!draft) return;
    const found = validateMark(draft);
    if (found.location || found.description) {
      setErrors(found);
      return;
    }

    const mark: MarkedChange = {
      id: draft.id,
      type: draft.type,
      ...(draft.surface ? { surface: draft.surface } : {}),
      location: draft.location.trim(),
      description: draft.description.trim(),
      ...(draft.box ? { box: draft.box } : {}),
    };

    onMarksChange(
      draft.editing ? marks.map((m) => (m.id === mark.id ? mark : m)) : [...marks, mark],
    );
    setDraft(null);
    setErrors({});
  }, [draft, marks, onMarksChange]);

  const remove = useCallback(
    (id: string) => {
      onMarksChange(marks.filter((m) => m.id !== id));
      setDraft((current) => (current?.id === id ? null : current));
    },
    [marks, onMarksChange],
  );

  const liveBox = drawing?.box;

  return (
    <div className={className}>
      <div
        ref={frameRef}
        data-testid="marker-frame"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className="relative w-full select-none overflow-hidden rounded-lg bg-slate-900"
        style={{ aspectRatio: String(frameAspect), touchAction: 'none' }}
      >
        <img
          src={imageUrl}
          alt={imageAlt}
          draggable={false}
          onLoad={(e) => {
            const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
            if (w > 0 && h > 0) setMeasured(w / h);
          }}
          className="pointer-events-none absolute inset-0 h-full w-full object-contain"
        />

        {marks.map((mark, index) =>
          mark.box ? (
            <div
              key={mark.id}
              data-testid={`mark-box-${mark.id}`}
              className="pointer-events-none absolute border-2 border-amber-400 bg-amber-400/10"
              style={boxToPercentStyle(projectBoxToFrame(mark.box, content))}
            >
              <span className="absolute left-0 top-0 -translate-y-full rounded bg-amber-400 px-1 text-[10px] font-semibold text-slate-900">
                {index + 1}
              </span>
            </div>
          ) : null,
        )}

        {liveBox ? (
          <div
            data-testid="draft-box"
            className="pointer-events-none absolute border-2 border-dashed border-sky-300 bg-sky-300/10"
            style={boxToPercentStyle(projectBoxToFrame(liveBox, content))}
          />
        ) : null}
      </div>

      <p className="mt-2 text-xs text-slate-600">
        Drag a box around anything that has changed since move-in, then describe it.
      </p>

      {/*
        The same form without a box. web-contract §0.2: the add-a-change path is
        the primary action and must be reachable in one tap — including for
        someone who cannot drag.
      */}
      <button
        type="button"
        onClick={startUndrawn}
        className="mt-2 w-full rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800"
      >
        Add a change without drawing
      </button>

      {draft ? (
        <form
          data-testid="mark-form"
          aria-label={draft.editing ? 'Edit change' : 'Add change'}
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
          className="mt-3 space-y-3 rounded-lg border border-slate-300 bg-white p-3"
        >
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs font-medium text-slate-700">
              What kind of change
              <select
                value={draft.type}
                onChange={(e) => setDraft({ ...draft, type: e.target.value as ChangeType })}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-2 text-sm"
              >
                {CHANGE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {humanise(type)}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-xs font-medium text-slate-700">
              Surface (optional)
              <select
                value={draft.surface}
                onChange={(e) =>
                  setDraft({ ...draft, surface: e.target.value as ChangeSurface | '' })
                }
                className="mt-1 w-full rounded border border-slate-300 px-2 py-2 text-sm"
              >
                <option value="">Not specified</option>
                {CHANGE_SURFACES.map((surface) => (
                  <option key={surface} value={surface}>
                    {humanise(surface)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block text-xs font-medium text-slate-700">
            Where in the room
            <input
              type="text"
              value={draft.location}
              maxLength={200}
              onChange={(e) => setDraft({ ...draft, location: e.target.value })}
              placeholder="wall left of the window"
              aria-invalid={errors.location ? true : undefined}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-2 text-sm"
            />
            {errors.location ? (
              <span role="alert" className="mt-1 block text-xs font-normal text-rose-700">
                {errors.location}
              </span>
            ) : null}
          </label>

          <label className="block text-xs font-medium text-slate-700">
            What changed
            <textarea
              value={draft.description}
              maxLength={600}
              rows={3}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="Describe what is different from the move-in photograph."
              aria-invalid={errors.description ? true : undefined}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-2 text-sm"
            />
            {errors.description ? (
              <span role="alert" className="mt-1 block text-xs font-normal text-rose-700">
                {errors.description}
              </span>
            ) : null}
          </label>

          <div className="flex gap-2">
            <button
              type="submit"
              className="flex-1 rounded bg-slate-900 px-3 py-2 text-sm font-semibold text-white"
            >
              {draft.editing ? 'Save change' : 'Add change'}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setErrors({});
              }}
              className="rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {marks.length > 0 ? (
        <ul className="mt-4 space-y-2" data-testid="mark-list">
          {marks.map((mark, index) => (
            <li
              key={mark.id}
              data-testid={`mark-${mark.id}`}
              className="rounded-lg border border-slate-200 p-3"
            >
              <div className="flex items-start gap-2">
                <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded bg-amber-400 text-[10px] font-bold text-slate-900">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-900">
                    {humanise(mark.type)}
                    {mark.surface ? ` · ${humanise(mark.surface)}` : ''}
                  </p>
                  <p className="text-xs text-slate-600">{mark.location}</p>
                  <p className="mt-1 text-sm text-slate-800">{mark.description}</p>
                </div>
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => startEdit(mark)}
                  className="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => remove(mark.id)}
                  className="rounded border border-rose-300 px-2 py-1 text-xs font-medium text-rose-700"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
