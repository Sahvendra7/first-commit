/**
 * Human edits over the suggestion set — architecture.md §9.6, §9.7.
 *
 * §9.7: "the tenant must affirmatively accept each change before it enters a
 * letter". This module is where that stops being a sentence in a document and
 * becomes a function nothing can route around.
 *
 * Two rules, both absolute:
 *
 *   1. **Tenant decisions always win.** Re-sampling the model cannot resurrect
 *      a rejected change, un-accept an accepted one, or delete one the tenant
 *      wrote. A model re-run is new evidence about the photographs; it is not
 *      new evidence about what the tenant decided.
 *   2. **Only `TENANT_ACCEPTED` and `TENANT_ADDED` may reach a document.** A
 *      `MODEL_SUGGESTED` change is a suggestion no human has looked at, and it
 *      does not matter how many runs agreed on it.
 *
 * Rejections are kept on the record rather than deleted. The audit trail is
 * the product; a change list with silent removals is not evidence of anything.
 *
 * Domain module: no AWS imports, no I/O, no clock.
 */

import { changeId, type MergedChange, type UntrustedModelConfidence } from './merge.js';
import type { WireChange } from './parse.js';

/** How a change came to be on the list. */
export const CHANGE_PROVENANCES = [
  /** The model proposed it and no human has ruled on it yet. */
  'MODEL_SUGGESTED',
  /** The tenant looked at it and said yes. May be rendered. */
  'TENANT_ACCEPTED',
  /** The tenant looked at it and said no. Retained, never rendered. */
  'TENANT_REJECTED',
  /** The tenant wrote it themselves. May be rendered. */
  'TENANT_ADDED',
] as const;
export type ChangeProvenance = (typeof CHANGE_PROVENANCES)[number];

/** The provenances a generated document is permitted to contain. */
export const DOCUMENT_ELIGIBLE_PROVENANCES: readonly ChangeProvenance[] = [
  'TENANT_ACCEPTED',
  'TENANT_ADDED',
];

export interface ReviewedChange {
  readonly id: string;
  readonly type: WireChange['type'];
  readonly surface?: WireChange['surface'];
  readonly location: string;
  readonly description: string;
  readonly provenance: ChangeProvenance;
  /** Absent on a tenant-written change: no model, no agreement to report. */
  readonly agreementFrequency?: number;
  readonly runCount?: number;
  /** Absent on a tenant-written change. Display only wherever it is present. */
  readonly untrustedModelConfidence?: UntrustedModelConfidence;
}

export interface TenantDecision {
  readonly changeId: string;
  readonly action: 'ACCEPT' | 'REJECT';
}

/** A change the tenant wrote, typically one the model missed. */
export interface TenantAddition {
  readonly type: WireChange['type'];
  readonly surface?: WireChange['surface'];
  readonly location: string;
  readonly description: string;
}

export interface ApplyTenantDecisionsInput {
  /** The current merged suggestion set for the room. */
  readonly suggestions: readonly MergedChange[];
  /** New accept/reject decisions. Later entries win over earlier ones. */
  readonly decisions?: readonly TenantDecision[];
  /** New tenant-written changes. */
  readonly additions?: readonly TenantAddition[];
  /** The stored review state from before this call, if the room has one. */
  readonly previous?: readonly ReviewedChange[];
}

const STICKY: readonly ChangeProvenance[] = ['TENANT_ACCEPTED', 'TENANT_REJECTED', 'TENANT_ADDED'];

function isSticky(change: ReviewedChange): boolean {
  return STICKY.includes(change.provenance);
}

function fromSuggestion(suggestion: MergedChange): ReviewedChange {
  return {
    id: suggestion.id,
    type: suggestion.type,
    ...(suggestion.surface !== undefined ? { surface: suggestion.surface } : {}),
    location: suggestion.location,
    description: suggestion.description,
    provenance: 'MODEL_SUGGESTED',
    agreementFrequency: suggestion.agreementFrequency,
    runCount: suggestion.runCount,
    untrustedModelConfidence: suggestion.untrustedModelConfidence,
  };
}

function fromAddition(addition: TenantAddition): ReviewedChange {
  return {
    id: changeId('tnt', addition.surface ?? 'UNSPECIFIED', addition.description),
    type: addition.type,
    ...(addition.surface !== undefined ? { surface: addition.surface } : {}),
    location: addition.location,
    description: addition.description,
    provenance: 'TENANT_ADDED',
  };
}

/**
 * Fold a tenant's accept/reject/add decisions over the current suggestion set,
 * carrying forward every decision they have already made.
 */
export function applyTenantDecisions(input: ApplyTenantDecisionsInput): ReviewedChange[] {
  const { suggestions, decisions = [], additions = [], previous = [] } = input;

  const stickyBefore = new Map<string, ReviewedChange>();
  for (const change of previous) {
    if (isSticky(change)) stickyBefore.set(change.id, change);
  }

  const result: ReviewedChange[] = [];
  const seen = new Set<string>();

  // Current suggestions first, each inheriting any decision already made
  // about it. Wording may have shifted between samples; the decision has not.
  for (const suggestion of suggestions) {
    const decided = stickyBefore.get(suggestion.id);
    const base = fromSuggestion(suggestion);
    result.push(decided ? { ...base, provenance: decided.provenance } : base);
    seen.add(suggestion.id);
  }

  // Then anything the tenant has ruled on that this sample no longer proposes.
  // Dropping it here would be the model silently overruling a human.
  for (const change of previous) {
    if (isSticky(change) && !seen.has(change.id)) {
      result.push(change);
      seen.add(change.id);
    }
  }

  // New decisions. Last one wins; an id we do not know is ignored rather than
  // conjured into existence.
  const latest = new Map<string, TenantDecision['action']>();
  for (const decision of decisions) latest.set(decision.changeId, decision.action);

  const decided = result.map((change) => {
    const action = latest.get(change.id);
    if (action === undefined) return change;
    if (change.provenance === 'TENANT_ADDED') return change;
    return {
      ...change,
      provenance: action === 'ACCEPT' ? ('TENANT_ACCEPTED' as const) : ('TENANT_REJECTED' as const),
    };
  });

  for (const addition of additions) {
    const change = fromAddition(addition);
    if (seen.has(change.id)) continue;
    decided.push(change);
    seen.add(change.id);
  }

  return decided;
}

/**
 * The gate. Everything a PDF renders passes through here, and nothing else is
 * permitted to (§9.7).
 */
export function changesForDocument(reviewed: readonly ReviewedChange[]): ReviewedChange[] {
  return reviewed.filter((change) => DOCUMENT_ELIGIBLE_PROVENANCES.includes(change.provenance));
}
