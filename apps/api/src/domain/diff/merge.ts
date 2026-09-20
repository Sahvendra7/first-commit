/**
 * Self-consistency merge — architecture.md §9.2, §9.5.
 *
 * The finding this module exists for: **the model is non-deterministic at
 * `temperature: 0`.** Four identical calls on one hard photograph pair
 * returned four different change lists — different counts, different wording,
 * different locations, different confidences — and nothing appeared in all
 * four. A single call is a draw from a distribution, so treating one response
 * as an answer is a category error.
 *
 * So: sample N times, cluster semantically-equivalent changes across the
 * samples, and keep only what at least k of them independently reported. The
 * confidence the system trusts is `agreementFrequency` — a count, computed
 * here, in code. The model's own `confidence` rides along for display and is
 * named to make misuse hard.
 *
 * Domain module: no AWS imports, no I/O, no randomness, no clock. Same input,
 * same output, every time.
 */

import type { WireChange, WireDiffResult } from './parse.js';

export interface MergeOptions {
  /** Minimum runs a cluster must appear in to survive. Default 3. */
  readonly minAgreement?: number;
  /** Token-overlap threshold for "the same physical feature". Default 0.45. */
  readonly similarityThreshold?: number;
}

export const MERGE_DEFAULTS = {
  /** N — how many times the adapter samples one pair. */
  sampleCount: 5,
  /** k — how many of those must agree. */
  minAgreement: 3,
  similarityThreshold: 0.45,
} as const;

/**
 * The model's own confidence number, carried for display only.
 *
 * It is uncalibrated: measured on real pairs, the single most obviously wrong
 * item scored 0.7 while a triplicate of one feature scored 0.9 / 0.85 / 0.8.
 * There is no threshold on it that separates good output from bad.
 *
 * Note what is deliberately absent: no mean, no max, no score. There is
 * nothing here to accidentally do arithmetic with. Per §9.2 this value may be
 * displayed and may route a room to `NEEDS_REVIEW`; it may never enter a
 * calculation or a generated document.
 */
export interface UntrustedModelConfidence {
  /** One entry per contributing run, in run order. */
  readonly reported: readonly number[];
  readonly trusted: false;
  readonly note: string;
}

export interface MergedChange {
  /** Stable and content-derived: the same cluster always gets the same id. */
  readonly id: string;
  readonly type: WireChange['type'];
  readonly surface?: WireChange['surface'];
  readonly location: string;
  readonly description: string;
  /** Distinct runs that reported this feature. */
  readonly runCount: number;
  /** Total observations, which exceeds `runCount` when one run duplicated it. */
  readonly observationCount: number;
  /** `runCount / sampleCount`. The only confidence this system trusts. */
  readonly agreementFrequency: number;
  readonly untrustedModelConfidence: UntrustedModelConfidence;
}

export interface DroppedCluster {
  readonly representative: WireChange;
  readonly runCount: number;
  readonly observationCount: number;
  readonly agreementFrequency: number;
}

export interface MergedRoomDiff {
  readonly sampleCount: number;
  readonly minAgreement: number;
  /** Clusters that met the agreement bar. Suggestions, never findings (§9.6). */
  readonly changes: readonly MergedChange[];
  /**
   * Clusters that did not. Kept for observability and for the eval's
   * inter-run-agreement metric — never surfaced to the tenant as a change.
   */
  readonly dropped: readonly DroppedCluster[];
}

/* ------------------------------------------------------------------ */
/* Text similarity                                                     */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'of', 'on',
  'in', 'at', 'to', 'and', 'or', 'it', 'its', 'there', 'that', 'this', 'these',
  'those', 'with', 'from', 'has', 'have', 'had', 'by', 'as', 'for', 'but', 'than',
  'then', 'which', 'where', 'when', 'also', 'very', 'some', 'any', 'appears',
]);

/**
 * Crude suffix stripping, deliberately. "staining" and "stain" must land in
 * the same cluster; a real stemmer would be a dependency in the domain layer
 * for a gain this does not need.
 */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function tokenise(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
    .map(stem)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
  return new Set(tokens);
}

/** |A ∩ B| / min(|A|, |B|) — forgiving of one side being more verbose. */
function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

interface Observation {
  readonly runIndex: number;
  readonly change: WireChange;
  readonly descriptionTokens: Set<string>;
  readonly contextTokens: Set<string>;
}

/**
 * Two observations describe the same physical feature when they are on the
 * same surface and their wording overlaps. Description-only and
 * description-plus-location are both considered, and the stronger signal
 * wins: a run that gives a terse location should not be pushed into its own
 * cluster for it.
 */
function similarity(a: Observation, b: Observation): number {
  return Math.max(
    overlapCoefficient(a.descriptionTokens, b.descriptionTokens),
    overlapCoefficient(a.contextTokens, b.contextTokens),
  );
}

/** Surface is a hard partition: the same words on the wall and on the floor are two changes. */
function surfaceKey(change: WireChange): string {
  return change.surface ?? 'UNSPECIFIED';
}

/* ------------------------------------------------------------------ */
/* Stable ids                                                          */
/* ------------------------------------------------------------------ */

/** FNV-1a, 32-bit. Enough to key a cluster, and no dependency in the domain. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Content-derived so a re-run of the same pair produces the same ids, which is
 * what lets `human-edits.ts` keep a tenant's accept/reject decisions attached
 * across a re-sample.
 */
export function changeId(prefix: string, surface: string, description: string): string {
  const shape = [...tokenise(description)].sort().join(' ');
  return `${prefix}_${fnv1a(`${surface}|${shape}`)}`;
}

/* ------------------------------------------------------------------ */
/* The merge                                                           */
/* ------------------------------------------------------------------ */

interface Cluster {
  readonly surface: string;
  readonly members: Observation[];
}

function representativeOf(members: readonly Observation[], threshold: number): Observation {
  // The member most like the others — the consensus wording rather than the
  // most florid one. Ties break on description text so the result is stable.
  let best = members[0]!;
  let bestScore = -1;

  for (const candidate of members) {
    let score = 0;
    for (const other of members) {
      if (other === candidate) continue;
      score += similarity(candidate, other);
    }
    const isBetter =
      score > bestScore ||
      (score === bestScore && candidate.change.description < best.change.description);
    if (isBetter) {
      best = candidate;
      bestScore = score;
    }
  }

  void threshold;
  return best;
}

/**
 * Merge N sampled responses for one room pair into one change list.
 *
 * `sampleCount` is taken from `runs.length` rather than a setting: the report
 * must say how many samples actually came back, not how many were requested.
 */
export function mergeSelfConsistent(
  runs: readonly WireDiffResult[],
  options: MergeOptions = {},
): MergedRoomDiff {
  const sampleCount = runs.length;
  const minAgreement = options.minAgreement ?? MERGE_DEFAULTS.minAgreement;
  const threshold = options.similarityThreshold ?? MERGE_DEFAULTS.similarityThreshold;

  const clusters: Cluster[] = [];

  runs.forEach((run, runIndex) => {
    for (const change of run.changes) {
      const observation: Observation = {
        runIndex,
        change,
        descriptionTokens: tokenise(change.description),
        contextTokens: tokenise(`${change.description} ${change.location}`),
      };

      // Single-linkage against every member, so a chain of rewordings stays
      // one feature. First match wins, which keeps the pass deterministic.
      const existing = clusters.find(
        (cluster) =>
          cluster.surface === surfaceKey(change) &&
          cluster.members.some((member) => similarity(member, observation) >= threshold),
      );

      if (existing) existing.members.push(observation);
      else clusters.push({ surface: surfaceKey(change), members: [observation] });
    }
  });

  const changes: MergedChange[] = [];
  const dropped: DroppedCluster[] = [];

  for (const cluster of clusters) {
    // A feature reported three times in one response is one run's opinion, not
    // three. Measured: one run did exactly that, at 0.9 / 0.85 / 0.8.
    const runIndexes = new Set(cluster.members.map((member) => member.runIndex));
    const runCount = runIndexes.size;
    const observationCount = cluster.members.length;
    const agreementFrequency = sampleCount === 0 ? 0 : runCount / sampleCount;
    const representative = representativeOf(cluster.members, threshold);

    if (runCount < minAgreement) {
      dropped.push({
        representative: representative.change,
        runCount,
        observationCount,
        agreementFrequency,
      });
      continue;
    }

    // One number per contributing run, in run order — the first observation
    // from each run, so a duplicating run does not get extra weight.
    const reported: number[] = [];
    for (const runIndex of [...runIndexes].sort((a, b) => a - b)) {
      const first = cluster.members.find((member) => member.runIndex === runIndex);
      if (first) reported.push(first.change.confidence);
    }

    changes.push({
      id: changeId('chg', cluster.surface, representative.change.description),
      type: representative.change.type,
      ...(representative.change.surface !== undefined
        ? { surface: representative.change.surface }
        : {}),
      location: representative.change.location,
      description: representative.change.description,
      runCount,
      observationCount,
      agreementFrequency,
      untrustedModelConfidence: {
        reported,
        trusted: false,
        note: 'Model self-assessment. Uncalibrated. Display only — never arithmetic, never a document.',
      },
    });
  }

  return { sampleCount, minAgreement, changes, dropped };
}
