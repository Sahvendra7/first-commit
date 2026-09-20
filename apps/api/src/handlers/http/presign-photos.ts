/**
 * `POST /v1/tenancies/{id}/photos:presign` — architecture.md §7, §10.1.
 *
 * Order of operations is the security property here, and it is deliberate:
 *
 *   1. verified subject from the JWT,
 *   2. **ownership asserted**,
 *   3. only then is any request content used to plan anything.
 *
 * A client that does not own the tenancy gets `NOT_FOUND` before its `roomId`
 * or file list is examined at all, so the endpoint cannot be used to probe
 * which rooms exist on somebody else's tenancy.
 */
import {
  presignPhotosRequestSchema,
  presignPhotosResponseSchema,
  tenancyPathSchema,
} from '@handover/shared';
import { getRooms, getTenancy } from '../../adapters/dynamo/evidence-store.js';
import { newPhotoId } from '../../adapters/ids.js';
import { signUploads } from '../../adapters/s3/presigner.js';
import { PresignRefusedError, planUploads } from '../../domain/evidence/presign.js';
import { NotOwnerError, assertOwnership } from '../../domain/tenancy/ownership.js';
import { HttpError, callerSub, ok, parse, parseBody, withErrors } from './http.js';
import type { ApiEvent, ApiResult } from './http.js';

export const handler = withErrors(async (event: ApiEvent): Promise<ApiResult> => {
  const sub = callerSub(event);
  const { id } = parse(tenancyPathSchema, event.pathParameters ?? {});

  let tenancy;
  try {
    tenancy = assertOwnership(await getTenancy(id), sub, id);
  } catch (err) {
    if (err instanceof NotOwnerError) throw new HttpError(404, 'NOT_FOUND');
    throw err;
  }

  const body = parseBody(event, presignPhotosRequestSchema);
  const rooms = await getRooms(id);

  let plans;
  try {
    plans = planUploads(body, {
      tenancyId: id,
      status: tenancy.status,
      roomIds: rooms.map((r) => r.roomId),
      now: new Date(),
      newPhotoId,
    });
  } catch (err) {
    if (err instanceof PresignRefusedError) {
      // A room that is not on this tenancy is reported as a 404 on the room,
      // not a 422: the caller owns the tenancy, so the honest answer is that
      // the room does not exist here.
      if (err.code === 'UNKNOWN_ROOM') throw new HttpError(404, 'NOT_FOUND', err.message);
      if (err.code === 'PHASE_CLOSED') {
        throw new HttpError(409, 'PHASE_ALREADY_COMPLETE', err.message);
      }
      throw new HttpError(422, 'VALIDATION_FAILED', err.message);
    }
    throw err;
  }

  const uploads = await signUploads(plans);

  return ok(presignPhotosResponseSchema.parse({ uploads }));
});
