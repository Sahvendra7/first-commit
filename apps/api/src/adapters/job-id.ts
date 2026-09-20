/**
 * Deterministic job identifiers.
 *
 * §7 requires phase completion to be idempotent: "re-completing a completed
 * phase returns the existing `jobId` rather than starting a second job".
 *
 * A tenancy has at most one job per type by construction — one Condition
 * Report, one diff run — so the id can be *derived* from `(tenancyId, jobType)`
 * rather than stored. That turns idempotency into a property of the key rather
 * than a lookup that has to find a pointer, which matters because `TenancyItem`
 * is a frozen shape with nowhere to put one, and because jobs live in their own
 * partition (AP-6) and so never appear in a tenancy query.
 *
 * The digest is truncated to 32 hex characters: with a `j_` prefix that is 34
 * characters, inside `idSchema`'s 64-character bound, and 128 bits is far more
 * than enough when the input space is one pair per tenancy.
 */
import { createHash } from 'node:crypto';
import type { JobType } from '@handover/shared';

export function phaseJobId(tenancyId: string, jobType: JobType): string {
  const digest = createHash('sha256').update(`${tenancyId}#${jobType}`).digest('hex');
  return `j_${digest.slice(0, 32)}`;
}
