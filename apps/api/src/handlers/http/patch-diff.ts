/**
 * `PATCH /v1/tenancies/{id}/diff/{roomId}` — architecture.md §7, §9.6, §9.7.
 *
 * §7 calls this endpoint non-negotiable: "the model will be wrong sometimes,
 * and the human must own the final record." With the suggestion layer off by
 * default (§9.6), the `additions` half of it is not a correction path at all —
 * it is the **primary** way a change list comes to exist, and it has to work
 * with no model output on the screen (`docs/web-contract.md` §0.2).
 *
 * Thin adapter (§5.3): authorize, validate, hand a pure fold to the store,
 * serialise. The decision logic is `domain/diff/patch-room.ts`; the conditional
 * write and its contention retry are `adapters/dynamo/evidence-store.ts`.
 *
 * Order of operations is the security property, as in presign: ownership is
 * asserted before the body or the room id is looked at, so a caller who does
 * not own the tenancy cannot learn which rooms it has.
 */
import { patchDiffRequestSchema, patchDiffResponseSchema, roomDiffPathSchema } from '@handover/shared';
import type { RoomItem } from '@handover/shared';
import { getRooms, getTenancy, patchRoomDiff } from '../../adapters/dynamo/evidence-store.js';
import { newChangeId } from '../../adapters/ids.js';
import { toRoomDiff } from '../../domain/evidence/aggregate.js';
import { applyPatchToChanges } from '../../domain/diff/patch-room.js';
import type { PersistedDiffItem } from '../../domain/diff/persisted.js';
import { NotOwnerError, assertOwnership } from '../../domain/tenancy/ownership.js';
import { HttpError, callerSub, ok, parse, parseBody, withErrors } from './http.js';
import type { ApiEvent, ApiResult } from './http.js';

export const handler = withErrors(async (event: ApiEvent): Promise<ApiResult> => {
  const sub = callerSub(event);
  const { id, roomId } = parse(roomDiffPathSchema, event.pathParameters ?? {});

  try {
    assertOwnership(await getTenancy(id), sub, id);
  } catch (err) {
    if (err instanceof NotOwnerError) throw new HttpError(404, 'NOT_FOUND');
    throw err;
  }

  const body = parseBody(event, patchDiffRequestSchema);

  const rooms = await getRooms(id);
  const room: RoomItem | undefined = rooms.find((r) => r.roomId === roomId);
  // The caller owns the tenancy, so the honest answer for a room that is not
  // on it is that the room does not exist — the same 404 shape as everything
  // else, carrying no hint about which rooms do exist.
  if (!room) throw new HttpError(404, 'NOT_FOUND');

  const updated = await patchRoomDiff(id, roomId, (current): PersistedDiffItem => {
    /**
     * No DIFF item yet — the tenant is annotating a room before any worker
     * reached an opinion about it. The room is created as `NEEDS_REVIEW` with
     * **no `reviewReason`**: only a worker knows why a comparison did not
     * happen, and stamping `AI_DISABLED` here would assert something about a
     * run that was never attempted. The UI omits the line when the reason is
     * absent, which is the honest rendering.
     */
    const base: PersistedDiffItem = current ?? {
      PK: '',
      SK: '',
      entityType: 'DIFF',
      tenancyId: id,
      roomId,
      status: 'NEEDS_REVIEW',
      changes: [],
    };

    return {
      ...base,
      changes: applyPatchToChanges({
        existing: base.changes,
        // Both keys carry `.default([])` in the frozen schema, so they are
        // always present after parsing. The `?? []` is for the type checker
        // only: `patchDiffRequestSchema`'s input and output types differ
        // because of those defaults, and `parseBody` infers the input side.
        changes: body.changes ?? [],
        additions: body.additions ?? [],
        newChangeId,
      }),
    };
  });

  return ok(patchDiffResponseSchema.parse(toRoomDiff(updated, room.label)));
});
