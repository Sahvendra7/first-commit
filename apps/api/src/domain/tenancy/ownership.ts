/**
 * The ownership guard — architecture.md §10.1, §10.2.
 *
 * §10.2: "The ownership check is the entire authorization model." There is one
 * role, so there is no RBAC; what there is instead is this function, called
 * before any handler touches a tenancy's data.
 *
 * §10.1's first threat is cross-tenant data access, and the control is
 * "`assertOwnership()` in every handler; no endpoint accepts an owner ID from
 * the client". Both halves matter: the `callerSub` argument must come from
 * verified JWT claims, never from a body, a query string or a header the client
 * controls.
 */
import type { TenancyItem } from '@handover/shared';

/**
 * Raised when a caller asks for a tenancy that is not theirs, and when a
 * tenancy does not exist at all.
 *
 * The two are deliberately the same error with the same `NOT_FOUND` shape at
 * the edge. Distinguishing them would turn this endpoint into an oracle for
 * "does tenancy X exist", which leaks the existence of other people's records
 * to anyone willing to enumerate ids.
 */
export class NotOwnerError extends Error {
  readonly tenancyId: string;

  constructor(tenancyId: string) {
    super(`Tenancy ${tenancyId} is not accessible to this caller`);
    this.name = 'NotOwnerError';
    this.tenancyId = tenancyId;
  }
}

/**
 * Assert that `callerSub` owns `tenancy`, and narrow away `undefined` on the
 * way through.
 *
 * Returns the tenancy so call sites read as
 * `const tenancy = assertOwnership(await getTenancy(id), sub, id)` — there is
 * no way to use the result without having passed the check.
 */
export function assertOwnership(
  tenancy: TenancyItem | undefined,
  callerSub: string,
  tenancyId: string,
): TenancyItem {
  if (!tenancy) throw new NotOwnerError(tenancyId);
  if (typeof callerSub !== 'string' || callerSub.trim().length === 0) {
    throw new NotOwnerError(tenancyId);
  }
  if (tenancy.ownerSub !== callerSub) throw new NotOwnerError(tenancyId);
  return tenancy;
}
