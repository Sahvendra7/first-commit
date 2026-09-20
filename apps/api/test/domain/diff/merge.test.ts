import { describe, expect, it } from 'vitest';
import { mergeSelfConsistent } from '../../../src/domain/diff/merge.js';
import type { WireDiffResult } from '../../../src/domain/diff/parse.js';

/**
 * Self-consistency merge — §9.2 ("Deciding which of N model samples to believe
 * | Code"), §9.5.
 *
 * The model is non-deterministic at `temperature: 0`. One sample is not an
 * answer; it is a draw from a distribution. This merge is the only mechanism in
 * the system that turns N draws into something defensible, and the bar it
 * enforces is agreement, not the model's own confidence.
 */

function run(...changes: WireDiffResult['changes']): WireDiffResult {
  return { changes };
}

const stain = (confidence: number, description: string, location = 'floor near the doorway') => ({
  type: 'STAIN' as const,
  surface: 'FLOOR' as const,
  location,
  description,
  confidence,
});

describe('mergeSelfConsistent — agreement gate', () => {
  it('keeps a change every run reports, with agreementFrequency 1', () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      run(stain(0.5 + i * 0.05, 'A dark stain on the floor near the doorway, absent before.')),
    );
    const merged = mergeSelfConsistent(runs);
    expect(merged.changes).toHaveLength(1);
    expect(merged.changes[0]?.agreementFrequency).toBe(1);
    expect(merged.changes[0]?.runCount).toBe(5);
    expect(merged.sampleCount).toBe(5);
  });

  it('keeps a change at exactly k runs and reports the fraction', () => {
    const present = run(stain(0.7, 'A dark stain on the floor near the doorway.'));
    const runs = [present, present, present, run(), run()];
    const merged = mergeSelfConsistent(runs);
    expect(merged.changes).toHaveLength(1);
    expect(merged.changes[0]?.runCount).toBe(3);
    expect(merged.changes[0]?.agreementFrequency).toBeCloseTo(0.6);
  });

  it('drops a change seen in k-1 runs, however confident the model was', () => {
    const present = run(stain(0.99, 'A dark stain on the floor near the doorway.'));
    const merged = mergeSelfConsistent([present, present, run(), run(), run()]);
    expect(merged.changes).toEqual([]);
    expect(merged.dropped).toHaveLength(1);
    expect(merged.dropped[0]?.runCount).toBe(2);
  });

  it('honours configurable N and k', () => {
    const present = run(stain(0.4, 'A dark stain on the floor near the doorway.'));
    const merged = mergeSelfConsistent([present, present, run()], { minAgreement: 2 });
    expect(merged.sampleCount).toBe(3);
    expect(merged.minAgreement).toBe(2);
    expect(merged.changes).toHaveLength(1);
  });

  it('defaults to N=5, k=3', () => {
    const merged = mergeSelfConsistent([run(), run(), run(), run(), run()]);
    expect(merged.sampleCount).toBe(5);
    expect(merged.minAgreement).toBe(3);
  });
});

describe('mergeSelfConsistent — clustering', () => {
  it('clusters differently-worded descriptions of the same feature', () => {
    const merged = mergeSelfConsistent([
      run(stain(0.8, 'A dark stain on the floor near the doorway, not present before.')),
      run(stain(0.6, 'Dark staining on the floor near the doorway.')),
      run(stain(0.7, 'There is a dark stain near the doorway on the floor.')),
      run(),
      run(),
    ]);
    expect(merged.changes).toHaveLength(1);
    expect(merged.changes[0]?.runCount).toBe(3);
  });

  it('does not cluster the same words on different surfaces', () => {
    const onFloor = run(stain(0.8, 'A dark stain near the doorway.'));
    const onWall = run({
      type: 'STAIN',
      surface: 'WALL',
      location: 'wall near the doorway',
      description: 'A dark stain near the doorway.',
      confidence: 0.8,
    });
    const merged = mergeSelfConsistent([onFloor, onWall, onFloor, onWall, onFloor]);
    // Floor reaches 3, wall reaches 2. Only the floor survives.
    expect(merged.changes).toHaveLength(1);
    expect(merged.changes[0]?.surface).toBe('FLOOR');
  });

  it('counts a feature reported three times in ONE run as one run, not three', () => {
    const triplicate = run(
      stain(0.9, 'A dark stain on the floor near the doorway.'),
      stain(0.85, 'Dark staining on the floor by the doorway.'),
      stain(0.8, 'A stain on the floor near the door.'),
    );
    const merged = mergeSelfConsistent([triplicate, run(), run(), run(), run()]);
    expect(merged.changes).toEqual([]);
    expect(merged.dropped).toHaveLength(1);
    expect(merged.dropped[0]?.runCount).toBe(1);
    expect(merged.dropped[0]?.observationCount).toBe(3);
  });

  it('emits one entry per surviving cluster, never a duplicate', () => {
    const both = run(
      stain(0.7, 'A dark stain on the floor near the doorway.'),
      {
        type: 'CRACK',
        surface: 'WALL',
        location: 'wall above the switch',
        description: 'A hairline crack above the light switch.',
        confidence: 0.6,
      },
    );
    const merged = mergeSelfConsistent([both, both, both, run(), run()]);
    expect(merged.changes).toHaveLength(2);
    expect(new Set(merged.changes.map((c) => c.id)).size).toBe(2);
  });

  it('is deterministic — same input, same ids and same order', () => {
    const runs = [
      run(stain(0.7, 'A dark stain on the floor near the doorway.')),
      run(stain(0.5, 'Dark staining on the floor by the doorway.')),
      run(stain(0.9, 'A stain near the doorway on the floor.')),
      run(),
      run(),
    ];
    expect(mergeSelfConsistent(runs)).toEqual(mergeSelfConsistent(runs));
  });
});

describe('mergeSelfConsistent — confidence discipline', () => {
  it('derives confidence from agreement, not from the model', () => {
    const present = run(stain(0.05, 'A dark stain on the floor near the doorway.'));
    const merged = mergeSelfConsistent([present, present, present, present, present]);
    // The model said 0.05 five times. Five-of-five agreement is what counts.
    expect(merged.changes[0]?.agreementFrequency).toBe(1);
  });

  it('carries the model numbers through under an explicitly untrusted name', () => {
    const merged = mergeSelfConsistent([
      run(stain(0.9, 'A dark stain on the floor near the doorway.')),
      run(stain(0.85, 'Dark staining on the floor by the doorway.')),
      run(stain(0.8, 'A stain near the doorway on the floor.')),
      run(),
      run(),
    ]);
    const carried = merged.changes[0]?.untrustedModelConfidence;
    expect(carried?.reported).toEqual([0.9, 0.85, 0.8]);
    expect(carried?.trusted).toBe(false);
  });

  it('carries one run\'s own confidence for the wire, never an aggregate of them', () => {
    // The frozen `diffChangeSchema.confidence` is required and is documented
    // as model-reported, so something has to fill it. `representativeConfidence`
    // is the representative run's own number — a selection, not arithmetic —
    // and it must be one of the reported values rather than any function of
    // them.
    const merged = mergeSelfConsistent([
      run(stain(0.9, 'A dark stain on the floor near the doorway.')),
      run(stain(0.1, 'Dark staining on the floor by the doorway.')),
      run(stain(0.5, 'A stain near the doorway on the floor.')),
      run(),
      run(),
    ]);
    const only = merged.changes[0];
    expect(only?.untrustedModelConfidence.reported).toContain(only?.representativeConfidence);
    // Explicitly not the mean (0.5 happens to be a reported value too, so the
    // containment check above cannot catch an average on its own).
    expect(only?.representativeConfidence).toBe(only?.untrustedModelConfidence.reported[0]);
  });

  it('carries the representative run\'s wear-and-tear framing, both sides or neither', () => {
    const framed = {
      ...stain(0.8, 'A dark stain on the floor near the doorway.'),
      wearAndTear: {
        landlordMayArgue: 'The stain is new damage from a spill.',
        tenantsTypicallyCounter: 'Floor staining accrues with ordinary use.',
      },
    };
    const merged = mergeSelfConsistent([run(framed), run(framed), run(framed)]);

    expect(merged.changes[0]?.wearAndTear).toEqual({
      landlordMayArgue: 'The stain is new damage from a spill.',
      tenantsTypicallyCounter: 'Floor staining accrues with ordinary use.',
    });
  });

  it('omits wearAndTear entirely when the model offered none', () => {
    const present = run(stain(0.5, 'A dark stain on the floor near the doorway.'));
    const merged = mergeSelfConsistent([present, present, present]);
    expect(merged.changes[0]).not.toHaveProperty('wearAndTear');
  });

  it('exposes no aggregate of the model numbers to compute with', () => {
    const merged = mergeSelfConsistent([
      run(stain(0.9, 'A dark stain on the floor near the doorway.')),
      run(stain(0.1, 'Dark staining on the floor by the doorway.')),
      run(stain(0.5, 'A stain near the doorway on the floor.')),
      run(),
      run(),
    ]);
    const carried = merged.changes[0]?.untrustedModelConfidence as unknown as Record<string, unknown>;
    for (const forbidden of ['mean', 'average', 'max', 'min', 'score']) {
      expect(carried).not.toHaveProperty(forbidden);
    }
  });
});

/**
 * REGRESSION — the bracket pair, from four real responses (§9.5).
 *
 * Four identical calls at `temperature: 0` on one hard pair returned four
 * different change lists. Nothing appeared in all four. A pipe bracket visible
 * only in the after-photograph, because the camera moved, was reported as a
 * newly installed fixture at 0.9 confidence. One feature was reported three
 * times in a single response at 0.9 / 0.85 / 0.8.
 *
 * The merge must return nothing at all. This test is the reason the merge
 * exists; if it ever goes green-to-red, the suggestion layer is shipping
 * fabrications.
 */
describe('REGRESSION: the bracket pair — four real responses', () => {
  const runA: WireDiffResult = {
    changes: [
      {
        type: 'OTHER',
        surface: 'FIXED_FITTING',
        location: 'left-hand wall, near the floor',
        description: 'A metal pipe bracket has been installed on the left-hand wall.',
        confidence: 0.9,
      },
      {
        type: 'SCRATCH',
        surface: 'WALL',
        location: 'right of the window',
        description: 'A light scuff to the right of the window.',
        confidence: 0.4,
      },
    ],
  };

  const runB: WireDiffResult = {
    changes: [
      {
        type: 'DISCOLOURATION',
        surface: 'WALL',
        location: 'upper left corner',
        description: 'Yellowing in the upper left corner of the wall.',
        confidence: 0.9,
      },
      {
        type: 'DISCOLOURATION',
        surface: 'WALL',
        location: 'top left of the wall',
        description: 'The top left of the wall appears yellowed.',
        confidence: 0.85,
      },
      {
        type: 'DISCOLOURATION',
        surface: 'CEILING',
        location: 'corner where the wall meets the ceiling, upper left',
        description: 'Yellow discolouration where the upper left wall meets the ceiling.',
        confidence: 0.8,
      },
    ],
  };

  const runC: WireDiffResult = {
    changes: [
      {
        type: 'OTHER',
        surface: 'FIXED_FITTING',
        location: 'lower left of the frame',
        description: 'A pipe bracket is newly present at the lower left.',
        confidence: 0.9,
      },
      {
        type: 'CHIP',
        surface: 'FLOOR',
        location: 'centre of the floor',
        description: 'A small chip in the floor near the centre of the room.',
        confidence: 0.55,
      },
    ],
  };

  const runD: WireDiffResult = {
    changes: [
      {
        type: 'CRACK',
        surface: 'WALL',
        location: 'behind where the chair stood',
        description: 'A hairline crack on the wall behind the former chair position.',
        confidence: 0.7,
      },
    ],
  };

  const responses = [runA, runB, runC, runD];

  it('drops every item — nothing appeared in three of the four runs', () => {
    const merged = mergeSelfConsistent(responses, { minAgreement: 3 });
    expect(merged.changes).toEqual([]);
  });

  it('drops the fabricated bracket in particular, despite 0.9 twice', () => {
    const merged = mergeSelfConsistent(responses, { minAgreement: 3 });
    const bracket = merged.dropped.find((d) => /bracket/i.test(d.representative.description));
    expect(bracket).toBeDefined();
    expect(bracket?.runCount).toBe(2);
    expect(merged.changes.some((c) => /bracket/i.test(c.description))).toBe(false);
  });

  it('counts the triplicated discolouration as one run, not three', () => {
    const merged = mergeSelfConsistent(responses, { minAgreement: 3 });
    const yellow = merged.dropped.filter((d) => /yellow/i.test(d.representative.description));
    for (const cluster of yellow) {
      expect(cluster.runCount).toBe(1);
    }
  });

  it('still drops everything at k=2 of 4 for the singly-reported items', () => {
    const merged = mergeSelfConsistent(responses, { minAgreement: 2 });
    // Only the bracket reaches 2 runs. Everything else is a single sighting.
    expect(merged.changes.map((c) => c.surface)).toEqual(['FIXED_FITTING']);
  });

  it('records the sample count so the report can say four, not five', () => {
    const merged = mergeSelfConsistent(responses, { minAgreement: 3 });
    expect(merged.sampleCount).toBe(4);
  });
});
