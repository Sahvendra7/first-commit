/**
 * State-rule resolution — architecture.md §9.2, §6.3, R9.
 *
 * §9.2 is the load-bearing table in the spec, and this module sits on the
 * "data table" side of it: statutory references, deadlines, authority names
 * and the escalation ladder are **reviewed data**, mapped here without
 * interpretation. Nothing in this file may consult a model, and nothing in it
 * may invent a value that the reviewed table did not supply.
 *
 * The deadline arithmetic lives here rather than in a handler for the same
 * reason the claim arithmetic does: the date this produces is printed in a
 * legal document, so it has to be a pure function with a test around every
 * boundary it can cross.
 *
 * Domain module: no AWS imports, no I/O, no clock of its own.
 */
import type { GetStateRulesResponse, IsoDate, StateRuleItem } from '@handover/shared';

/**
 * Raised when a tenancy names a state the reviewed table does not carry.
 *
 * A refusal, never a default. Falling back to another state's refund window
 * would put a wrong statutory deadline in front of a tenant, which is exactly
 * the R9 failure the review date exists to make visible.
 */
export class UnknownStateError extends Error {
  readonly stateCode: string;

  constructor(stateCode: string) {
    super(`No reviewed state rules for ${stateCode}`);
    this.name = 'UnknownStateError';
    this.stateCode = stateCode;
  }
}

/** Narrow a possibly-absent rule to a present one, or refuse. */
export function resolveStateRule(
  rule: StateRuleItem | undefined,
  stateCode: string,
): StateRuleItem {
  if (!rule) throw new UnknownStateError(stateCode);
  return rule;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Add whole days to an ISO calendar date, in UTC.
 *
 * UTC is not incidental. `new Date('2026-09-20')` parses as midnight UTC but
 * `getDate()` reports the host's local day, so the same input yields a
 * different deadline on a laptop in Europe and a Lambda in ap-south-1. The
 * whole point of this value is that it is the same everywhere it is computed,
 * because it is printed in a demand letter.
 *
 * A malformed input throws rather than yielding `Invalid Date`, whose
 * `toISOString()` would either throw later or, worse, be caught and defaulted
 * somewhere downstream.
 */
export function addDays(date: IsoDate, days: number): IsoDate {
  const match = ISO_DATE.exec(date);
  if (!match) throw new RangeError(`Not an ISO-8601 calendar date: ${String(date)}`);
  if (!Number.isInteger(days) || days < 0) {
    throw new RangeError(`Day count must be a non-negative integer: ${String(days)}`);
  }

  const [, y, m, d] = match as unknown as [string, string, string, string];
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);

  const utc = Date.UTC(year, month - 1, day);
  const parsed = new Date(utc);
  // Round-trip check: Date.UTC silently normalises 2026-13-01 into 2027-01-01,
  // which would turn a typo in a reviewed table into a plausible wrong date.
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new RangeError(`Not a real calendar date: ${date}`);
  }

  return new Date(utc + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The refund deadline: handover plus the state's refund window.
 *
 * The window comes from the rule item, never from a constant here — one entry
 * in the table is what proves the rules are data-driven rather than hardcoded
 * (§15.2), and a number baked into this function would quietly undo that.
 */
export function refundDueDateFor(handoverDate: IsoDate, rule: StateRuleItem): IsoDate {
  return addDays(handoverDate, rule.refundWindowDays);
}

/**
 * Map the persisted rule onto the public wire shape (§7 `GET /v1/state-rules`).
 *
 * Note what is *not* here: `updatedAt` does not become `lastReviewedAt`, and
 * neither does today's date. A write is not a review. When the field is
 * absent it stays absent, travels absent, and the UI omits the line — which is
 * the entire R9 mitigation, and the reason `data/state-rules/KA.json` ships
 * without one.
 */
export function toStateRulesResponse(rule: StateRuleItem): GetStateRulesResponse {
  return {
    stateCode: rule.stateCode,
    stateName: rule.stateName,
    mtaAdopted: rule.mtaAdopted,
    depositCapMonths: rule.depositCapMonths,
    refundWindowDays: rule.refundWindowDays,
    statutoryInterestBps: rule.statutoryInterestBps,
    authorityName: rule.authorityName,
    escalationSteps: rule.escalationSteps.map((step) => ({
      order: step.order,
      label: step.label,
      description: step.description,
      ...(step.afterDays !== undefined ? { afterDays: step.afterDays } : {}),
    })),
    statuteRefs: rule.statuteRefs.map((ref) => ({
      citation: ref.citation,
      title: ref.title,
      ...(ref.url !== undefined ? { url: ref.url } : {}),
    })),
    ...(rule.lastReviewedAt !== undefined ? { lastReviewedAt: rule.lastReviewedAt } : {}),
  };
}
