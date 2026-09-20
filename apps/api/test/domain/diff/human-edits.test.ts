import { describe, expect, it } from 'vitest';
import { mergeSelfConsistent } from '../../../src/domain/diff/merge.js';
import {
  applyTenantDecisions,
  changesForDocument,
  type ReviewedChange,
} from '../../../src/domain/diff/human-edits.js';
import type { WireDiffResult } from '../../../src/domain/diff/parse.js';

/**
 * §9.7: "the tenant must affirmatively accept each change before it enters a
 * letter". §9.6: the model layer produces suggestions, never findings.
 *
 * The rule these tests defend is narrow and absolute: a change reaches a
 * document only if a human put it there.
 */

const stain = (description: string, confidence = 0.7) => ({
  type: 'STAIN' as const,
  surface: 'FLOOR' as const,
  location: 'floor near the doorway',
  description,
  confidence,
});

const crack = (description: string, confidence = 0.6) => ({
  type: 'CRACK' as const,
  surface: 'WALL' as const,
  location: 'wall above the light switch',
  description,
  confidence,
});

function suggestionsFrom(...changes: WireDiffResult['changes'][]) {
  return mergeSelfConsistent(
    changes.map((c) => ({ changes: c })),
    { minAgreement: 1 },
  ).changes;
}

const twoSuggestions = () =>
  suggestionsFrom([stain('A dark stain on the floor near the doorway.'), crack('A hairline crack above the switch.')]);

describe('applyTenantDecisions — provenance', () => {
  it('marks untouched model output MODEL_SUGGESTED', () => {
    const reviewed = applyTenantDecisions({ suggestions: twoSuggestions() });
    expect(reviewed.map((c) => c.provenance)).toEqual(['MODEL_SUGGESTED', 'MODEL_SUGGESTED']);
  });

  it('marks an accepted change TENANT_ACCEPTED', () => {
    const suggestions = twoSuggestions();
    const reviewed = applyTenantDecisions({
      suggestions,
      decisions: [{ changeId: suggestions[0]!.id, action: 'ACCEPT' }],
    });
    expect(reviewed.find((c) => c.id === suggestions[0]!.id)?.provenance).toBe('TENANT_ACCEPTED');
  });

  it('marks a rejected change TENANT_REJECTED and keeps it on the record', () => {
    const suggestions = twoSuggestions();
    const reviewed = applyTenantDecisions({
      suggestions,
      decisions: [{ changeId: suggestions[0]!.id, action: 'REJECT' }],
    });
    const rejected = reviewed.find((c) => c.id === suggestions[0]!.id);
    expect(rejected?.provenance).toBe('TENANT_REJECTED');
    // Rejections are not deletions: the audit trail is the point.
    expect(rejected).toBeDefined();
  });

  it('marks a tenant-written change TENANT_ADDED with no model confidence', () => {
    const reviewed = applyTenantDecisions({
      suggestions: [],
      additions: [
        {
          type: 'BURN',
          surface: 'BUILT_IN_CABINETRY',
          location: 'kitchen worktop beside the hob',
          description: 'A burn mark on the worktop that the model did not find.',
        },
      ],
    });
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]?.provenance).toBe('TENANT_ADDED');
    expect(reviewed[0]?.untrustedModelConfidence).toBeUndefined();
    expect(reviewed[0]?.agreementFrequency).toBeUndefined();
  });

  it('ignores a decision for an unknown change id rather than inventing one', () => {
    const reviewed = applyTenantDecisions({
      suggestions: twoSuggestions(),
      decisions: [{ changeId: 'not-a-real-id', action: 'ACCEPT' }],
    });
    expect(reviewed).toHaveLength(2);
    expect(reviewed.every((c) => c.provenance === 'MODEL_SUGGESTED')).toBe(true);
  });

  it('applies the last decision when the tenant changes their mind', () => {
    const suggestions = twoSuggestions();
    const id = suggestions[0]!.id;
    const reviewed = applyTenantDecisions({
      suggestions,
      decisions: [
        { changeId: id, action: 'ACCEPT' },
        { changeId: id, action: 'REJECT' },
      ],
    });
    expect(reviewed.find((c) => c.id === id)?.provenance).toBe('TENANT_REJECTED');
  });
});

describe('applyTenantDecisions — tenant decisions always win', () => {
  it('a re-run of the model cannot resurrect a rejected change', () => {
    const suggestions = twoSuggestions();
    const previous = applyTenantDecisions({
      suggestions,
      decisions: [{ changeId: suggestions[0]!.id, action: 'REJECT' }],
    });

    // Same pair, sampled again. The model offers the same two suggestions.
    const rerun = applyTenantDecisions({ suggestions: twoSuggestions(), previous });

    expect(rerun.find((c) => c.id === suggestions[0]!.id)?.provenance).toBe('TENANT_REJECTED');
  });

  it('a re-run cannot un-accept an accepted change', () => {
    const suggestions = twoSuggestions();
    const previous = applyTenantDecisions({
      suggestions,
      decisions: [{ changeId: suggestions[0]!.id, action: 'ACCEPT' }],
    });
    const rerun = applyTenantDecisions({ suggestions: twoSuggestions(), previous });
    expect(rerun.find((c) => c.id === suggestions[0]!.id)?.provenance).toBe('TENANT_ACCEPTED');
  });

  it('a re-run cannot drop a tenant-added change the model never saw', () => {
    const previous = applyTenantDecisions({
      suggestions: [],
      additions: [
        {
          type: 'HOLE',
          surface: 'WALL',
          location: 'wall behind the door',
          description: 'A drilled hole behind the door.',
        },
      ],
    });
    const rerun = applyTenantDecisions({ suggestions: twoSuggestions(), previous });
    expect(rerun.filter((c) => c.provenance === 'TENANT_ADDED')).toHaveLength(1);
    expect(rerun).toHaveLength(3);
  });

  it('a change the model stops suggesting is retained if the tenant accepted it', () => {
    const suggestions = twoSuggestions();
    const previous = applyTenantDecisions({
      suggestions,
      decisions: [{ changeId: suggestions[0]!.id, action: 'ACCEPT' }],
    });
    const rerun = applyTenantDecisions({ suggestions: [], previous });
    expect(rerun.map((c) => c.provenance)).toEqual(['TENANT_ACCEPTED']);
  });

  it('a change the model stops suggesting is dropped if the tenant never touched it', () => {
    const previous = applyTenantDecisions({ suggestions: twoSuggestions() });
    const rerun = applyTenantDecisions({ suggestions: [], previous });
    expect(rerun).toEqual([]);
  });
});

describe('changesForDocument — the gate', () => {
  it('passes only TENANT_ACCEPTED and TENANT_ADDED', () => {
    const suggestions = twoSuggestions();
    const reviewed = applyTenantDecisions({
      suggestions,
      decisions: [
        { changeId: suggestions[0]!.id, action: 'ACCEPT' },
        { changeId: suggestions[1]!.id, action: 'REJECT' },
      ],
      additions: [
        {
          type: 'MISSING',
          surface: 'FIXTURE',
          location: 'ceiling, centre of the room',
          description: 'The ceiling light fitting is gone.',
        },
      ],
    });

    const forDoc = changesForDocument(reviewed);
    expect(forDoc.map((c) => c.provenance).sort()).toEqual(['TENANT_ACCEPTED', 'TENANT_ADDED']);
  });

  it('passes nothing at all when the tenant has reviewed nothing', () => {
    expect(changesForDocument(applyTenantDecisions({ suggestions: twoSuggestions() }))).toEqual([]);
  });

  it('never passes a MODEL_SUGGESTED change, whatever its agreement', () => {
    const unanimous = mergeSelfConsistent(
      Array.from({ length: 5 }, () => ({ changes: [stain('A dark stain on the floor.')] })),
    ).changes;
    expect(unanimous[0]?.agreementFrequency).toBe(1);
    expect(changesForDocument(applyTenantDecisions({ suggestions: unanimous }))).toEqual([]);
  });

  it('never passes a TENANT_REJECTED change', () => {
    const reviewed: ReviewedChange[] = applyTenantDecisions({
      suggestions: twoSuggestions(),
      decisions: twoSuggestions().map((s) => ({ changeId: s.id, action: 'REJECT' as const })),
    });
    expect(changesForDocument(reviewed)).toEqual([]);
  });
});
