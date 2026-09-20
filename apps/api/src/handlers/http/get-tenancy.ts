/**
 * `GET /v1/tenancies/{id}` — architecture.md §7.
 *
 * The full aggregate: metadata, rooms, photo references with presigned GET URLs
 * (5-minute expiry), diffs and documents. One AP-2 query, one batch of signing,
 * one pure assembly.
 *
 * `api-handler` deliberately has **no `s3:GetObject`** (§10.3): it signs URLs,
 * it never reads objects. Signing a GET requires only the credentials, not the
 * permission to perform it — but the resulting URL carries the signer's
 * identity, which is why the presign grant is scoped to the evidence prefix.
 */
import { getTenancyResponseSchema, tenancyPathSchema } from '@handover/shared';
import { getTenancyPartition } from '../../adapters/dynamo/evidence-store.js';
import { signEvidenceGets } from '../../adapters/s3/presigner.js';
import { signDocumentGets } from '../../adapters/s3/document-writer.js';
import {
  buildTenancyAggregate,
  documentKeysFor,
  evidenceKeysFor,
} from '../../domain/evidence/aggregate.js';
import { NotOwnerError, assertOwnership } from '../../domain/tenancy/ownership.js';
import { HttpError, callerSub, ok, parse, rethrowUnsigned, withErrors } from './http.js';
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
  // Two buckets, two signers. Evidence and generated documents live apart and
  // are governed by different rules (§5.8), so each is signed against the
  // bucket it is actually in; merging the results is safe because the keys are
  // distinct and the assembler looks them up by key.
  const [evidenceUrls, documentUrls] = await Promise.all([
    signEvidenceGets(evidenceKeysFor(items), now),
    signDocumentGets(documentKeysFor(items), now),
  ]);
  const urls = new Map([...evidenceUrls, ...documentUrls]);

  try {
    return ok(getTenancyResponseSchema.parse(buildTenancyAggregate(items, urls)));
  } catch (err) {
    rethrowUnsigned(err, id);
  }
});
