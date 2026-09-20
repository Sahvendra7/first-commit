/**
 * `GET /v1/tenancies/{id}/diff` — architecture.md §7, §9.6.
 *
 * Room-by-room change list with before/after presigned URLs, so the compare
 * slider has both images without a second round trip.
 *
 * §7: `NEEDS_REVIEW` rooms are returned **explicitly** rather than omitted. A
 * room the model could not read is the room the tenant most needs offered for
 * manual annotation; dropping it would turn a visible gap into an invisible
 * one, which is the failure mode §9.6 exists to prevent.
 */
import { getDiffResponseSchema, tenancyPathSchema } from '@handover/shared';
import { getTenancyPartition } from '../../adapters/dynamo/evidence-store.js';
import { signEvidenceGets } from '../../adapters/s3/presigner.js';
import { buildDiffView, evidenceKeysFor } from '../../domain/evidence/aggregate.js';
import { NotOwnerError, assertOwnership } from '../../domain/tenancy/ownership.js';
import { HttpError, callerSub, ok, parse, withErrors } from './http.js';
import type { ApiEvent, ApiResult } from './http.js';
import type { TenancyItem } from '@handover/shared';

export const handler = withErrors(async (event: ApiEvent): Promise<ApiResult> => {
  const sub = callerSub(event);
  const { id } = parse(tenancyPathSchema, event.pathParameters ?? {});

  const items = await getTenancyPartition(id);
  const meta = items.find((i): i is TenancyItem => i.entityType === 'TENANCY');

  try {
    assertOwnership(meta, sub, id);
  } catch (err) {
    if (err instanceof NotOwnerError) throw new HttpError(404, 'NOT_FOUND');
    throw err;
  }

  const now = new Date();
  const urls = await signEvidenceGets(evidenceKeysFor(items), now);

  return ok(getDiffResponseSchema.parse(buildDiffView(id, items, urls)));
});
