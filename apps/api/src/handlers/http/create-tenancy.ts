/**
 * `POST /v1/tenancies` — architecture.md §7.
 *
 * Thin adapter (§5.3): validate, authorize, build items, write, serialise.
 *
 * `ownerSub` comes from `callerSub(event)` and the request schema is `.strict()`
 * with no `ownerSub` field, so a client that tries to supply one is rejected
 * rather than ignored (§7: "set from token claims, never from the body").
 */
import {
  createTenancyRequestSchema,
  createTenancyResponseSchema,
  gsi1Pk,
  gsi1Sk,
  key,
  roomSk,
  tenancyPk,
  toPaise,
} from '@handover/shared';
import type { RoomItem, TenancyItem } from '@handover/shared';
import { getStateRule, putTenancyWithRooms } from '../../adapters/dynamo/evidence-store.js';
import { newRoomId, newTenancyId } from '../../adapters/ids.js';
import { HttpError, callerSub, ok, parseBody, withErrors } from './http.js';
import type { ApiEvent, ApiResult } from './http.js';

export const handler = withErrors(async (event: ApiEvent): Promise<ApiResult> => {
  const sub = callerSub(event);
  const body = parseBody(event, createTenancyRequestSchema);

  // §7: `stateCode` must exist in STATE_RULE. The statutory data is a reviewed
  // table (§9.2), so an unknown state is a refusal, never a default.
  const rule = await getStateRule(body.stateCode);
  if (!rule) {
    throw new HttpError(422, 'UNKNOWN_STATE', `No state rules for ${body.stateCode}`);
  }

  const now = new Date().toISOString();
  const tenancyId = newTenancyId();

  const rooms: RoomItem[] = body.rooms.map((room) => {
    const roomId = newRoomId();
    return {
      PK: tenancyPk(tenancyId),
      SK: roomSk(roomId),
      entityType: 'ROOM',
      tenancyId,
      roomId,
      label: room.label,
      orderIndex: room.orderIndex,
      photoCountMovein: 0,
      photoCountMoveout: 0,
    };
  });

  const tenancy: TenancyItem = {
    ...key.tenancyMeta(tenancyId),
    entityType: 'TENANCY',
    tenancyId,
    ownerSub: sub,
    addressLine: body.addressLine,
    city: body.city,
    stateCode: body.stateCode,
    // `toPaise` is the only sanctioned way to mint the branded type from an
    // untrusted number (§6.4). Zod has already checked the shape; this is the
    // runtime guard that the type-level promise is not drifting from.
    monthlyRentPaise: toPaise(body.monthlyRentPaise),
    depositPaise: toPaise(body.depositPaise),
    moveInDate: body.moveInDate,
    landlordEmail: body.landlordEmail,
    status: 'MOVEIN_PENDING',
    createdAt: now,
    updatedAt: now,
    // AP-4 is always written; AP-5's clock keys are not — a new tenancy is not
    // awaiting a refund, and GSI2 stays sparse (§6.2).
    GSI1PK: gsi1Pk(sub),
    GSI1SK: gsi1Sk(now),
  };

  await putTenancyWithRooms(tenancy, rooms);

  return ok(
    createTenancyResponseSchema.parse({
      tenancyId,
      status: 'MOVEIN_PENDING',
      rooms: rooms.map((r) => ({ roomId: r.roomId, label: r.label })),
    }),
    201,
  );
});
