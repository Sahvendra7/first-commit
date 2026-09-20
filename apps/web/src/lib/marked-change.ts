/**
 * A change the tenant marked, and its mapping onto the frozen contract.
 *
 * `diffAdditionSchema` is `{ type, surface?, location, description }` — there
 * is no geometry field, and `packages/shared` is frozen. So a `MarkedChange`
 * is a superset that exists only in the browser: the prose crosses the wire,
 * the box positions an overlay on screen and is dropped at the boundary.
 *
 * `box` is optional on purpose. The contract has never required one, and the
 * tenant-driven "add a change" path has to work for someone who cannot drag —
 * a change described in words is a complete, valid change.
 */
import {
  diffAdditionSchema,
  type ChangeSurface,
  type ChangeType,
  type DiffAddition,
} from '@handover/shared';
import type { NormalizedBox } from './geometry.js';

export interface MarkedChange {
  /** Client-local. The server assigns the real id when the PATCH returns. */
  readonly id: string;
  readonly type: ChangeType;
  readonly surface?: ChangeSurface;
  readonly location: string;
  readonly description: string;
  /** Normalised against the after photograph. Never sent. */
  readonly box?: NormalizedBox;
}

/**
 * Drops the geometry and validates what is left against the frozen schema, so
 * a mark that could not be sent fails here rather than at the API.
 */
export function toDiffAddition(mark: MarkedChange): DiffAddition {
  return diffAdditionSchema.parse({
    type: mark.type,
    ...(mark.surface ? { surface: mark.surface } : {}),
    location: mark.location,
    description: mark.description,
  });
}

export function toDiffAdditions(marks: readonly MarkedChange[]): DiffAddition[] {
  return marks.map(toDiffAddition);
}

/** Whether a draft is complete enough to send. Mirrors the schema's bounds. */
export function validateMark(draft: {
  location: string;
  description: string;
}): { location?: string; description?: string } {
  const errors: { location?: string; description?: string } = {};
  const location = draft.location.trim();
  const description = draft.description.trim();

  if (location.length === 0) errors.location = 'Say where in the room this is.';
  else if (location.length > 200) errors.location = 'Keep this under 200 characters.';

  if (description.length === 0) errors.description = 'Describe what changed.';
  else if (description.length > 600) errors.description = 'Keep this under 600 characters.';

  return errors;
}
