/**
 * Folding a tenant's edits over one room's change list — architecture.md §7,
 * §9.2, §9.7.
 *
 * §7 calls `PATCH /diff/{roomId}` non-negotiable: "the model will be wrong
 * sometimes, and the human must own the final record. It is also the honest
 * answer to a judge asking 'what if the AI is wrong.'" This module is that
 * ownership as a pure function over the persisted change list.
 *
 * Three rules it will not bend:
 *
 *  1. **Rejections stay on the record.** A rejected change is marked, never
 *     removed. An audit trail with silent deletions is not evidence of
 *     anything (§9.7, and the same rule in `human-edits.ts`).
 *  2. **A tenant-authored change carries no model confidence.** The frozen
 *     `diffChangeSchema` requires the field, so it is filled with a sentinel
 *     the system never reads — see `TENANT_AUTHORED_CONFIDENCE` below.
 *  3. **Ids come from the server.** A client never names a new change, so it
 *     can never collide with, or overwrite, an existing one.
 *
 * ── Relationship to `human-edits.ts` ────────────────────────────────────────
 * That module guards the *merge* path: when the model is re-sampled, a tenant's
 * decisions must survive the new suggestion set, so there a `TENANT_ADDED`
 * change is sticky and immune to being overruled. This module is the other
 * direction — the tenant explicitly saying so through the API — and here a
 * decision applies to any change the room holds, including one the tenant
 * wrote, because a human must be able to undo their own mistake. The two are
 * not in tension: one stops a *model* re-run from overruling a human, the
 * other lets a human overrule themselves.
 *
 * Domain module: no AWS imports, no I/O, no clock, no randomness (the id
 * source is injected).
 */
import type { ChangeAction, DiffAddition, DiffChange } from '@handover/shared';

/**
 * What goes in `confidence` for a change a person wrote.
 *
 * `diffAdditionSchema` has no confidence field — deliberately, because "a human
 * assertion is not a sampled one" — but `diffChangeSchema.confidence` is
 * required, and `packages/shared` is frozen. So the field is filled with a
 * value that is never consumed: the UI gates its confidence chip on
 * `source === 'MODEL'`, the merge never sees a tenant change, and the document
 * gate is provenance rather than any number. `apps/web`'s demo client records
 * exactly this, so `?demo=1` and the deployed API cannot drift apart.
 *
 * It is a placeholder for a required field, not an assertion about certainty.
 */
export const TENANT_AUTHORED_CONFIDENCE = 1;

export interface ApplyPatchInput {
  /** The room's current persisted change list. Never mutated. */
  readonly existing: readonly DiffChange[];
  /** Accept/reject decisions. Later entries win over earlier ones. */
  readonly changes: readonly { readonly id: string; readonly action: ChangeAction }[];
  /** Changes the tenant wrote themselves, typically ones the model missed. */
  readonly additions: readonly DiffAddition[];
  /** Injected so the domain stays deterministic and free of a random source. */
  readonly newChangeId: () => string;
}

export function applyPatchToChanges(input: ApplyPatchInput): DiffChange[] {
  const { existing, changes, additions, newChangeId } = input;

  // Last decision wins, which makes a batch carrying a correction behave the
  // same way two sequential calls would.
  const decisions = new Map<string, ChangeAction>();
  for (const decision of changes) decisions.set(decision.id, decision.action);

  const decided: DiffChange[] = existing.map((change) => {
    const action = decisions.get(change.id);
    // An id we do not hold is ignored rather than conjured into a change. The
    // response carries the real list and the client renders from it, so a
    // stale id surfaces as a change that is absent — not as a fabricated one.
    if (action === undefined) return change;
    return { ...change, tenantAction: action };
  });

  for (const addition of additions) {
    decided.push({
      id: newChangeId(),
      type: addition.type,
      ...(addition.surface !== undefined ? { surface: addition.surface } : {}),
      location: addition.location,
      description: addition.description,
      confidence: TENANT_AUTHORED_CONFIDENCE,
      source: 'TENANT',
      // Writing a change down is the affirmative acceptance §9.7 requires;
      // there is no second step in which the tenant approves their own words.
      tenantAction: 'ACCEPT',
    });
  }

  return decided;
}
