/**
 * Diff eval — architecture.md §9.5, §18.
 *
 *   pnpm eval:diff
 *
 * Scores the diff path against `eval/golden-set/`. Four metrics, reported
 * separately because they have different cost profiles:
 *
 *   recall              did it find the real change? a miss costs rupees
 *   false-positive rate did it invent one? THE HEADLINE — asymmetric risk
 *   inter-run agreement does the model agree with itself across N samples?
 *   parse health        failure rate, and fence / whitespace incidence
 *
 * It also runs prompt v1 against v2 on identical cases, so a prompt change is
 * a measurement rather than an opinion.
 *
 * Why this harness talks to the endpoint itself rather than through
 * `RoomDiffPort`: the port returns merged results, and three of the four
 * metrics above are properties of the *raw* responses — how often the object
 * was fenced, how often it failed to parse, how much the samples disagreed.
 * The eval must see what the model actually said. It shares the domain's
 * `parseModelResponse` and `mergeSelfConsistent` so it is scoring the same
 * code that ships, not a reimplementation of it.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import {
  mergeSelfConsistent,
  parseModelResponse,
  roomDiffPrompt,
  isPromptVersion,
  PROMPT_VERSIONS,
  type MergedChange,
  type MergedRoomDiff,
  type ParseDiagnostics,
  type PromptVersion,
  type WireDiffResult,
} from '@handover/api';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_SET = join(HERE, 'golden-set');
const DEFAULT_BASE_URL =
  process.env['BEDROCK_BASE_URL'] ?? 'https://bedrock-mantle.ap-south-1.api.aws/v1';

/* ------------------------------------------------------------------ */
/* Answer keys                                                         */
/* ------------------------------------------------------------------ */

const truthChangeSchema = z.object({
  surface: z.string().optional(),
  type: z.string().optional(),
  keywords: z.array(z.string().min(1)).min(1),
  description: z.string().optional(),
});

const forbiddenSchema = z.object({
  keywords: z.array(z.string().min(1)).min(1),
  why: z.string().optional(),
});

const truthSchema = z.object({
  kind: z.enum(['POSITIVE', 'DISTRACTOR', 'HARD_NEGATIVE']).default('POSITIVE'),
  notes: z.string().optional(),
  maxChanges: z.number().int().min(0).optional(),
  changes: z.array(truthChangeSchema).default([]),
  forbidden: z.array(forbiddenSchema).default([]),
});

type Truth = z.infer<typeof truthSchema>;

interface Case {
  readonly id: string;
  readonly dir: string;
  readonly truth: Truth;
}

/* ------------------------------------------------------------------ */
/* Sampling: recorded first, live only when asked                      */
/* ------------------------------------------------------------------ */

interface RawSample {
  readonly text: string;
  readonly source: 'recorded' | 'live';
}

type Sampling =
  | { readonly ok: true; readonly samples: readonly RawSample[] }
  | { readonly ok: false; readonly skipped: string };

async function recordedSamples(dir: string, version: PromptVersion): Promise<RawSample[] | undefined> {
  const folder = join(dir, 'responses', version);
  if (!existsSync(folder)) return undefined;
  const files = (await readdir(folder)).filter((f) => extname(f) === '.txt').sort();
  if (files.length === 0) return undefined;
  return Promise.all(
    files.map(async (file) => ({
      text: await readFile(join(folder, file), 'utf8'),
      source: 'recorded' as const,
    })),
  );
}

function mimeOf(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/jpeg';
  }
}

async function imagePart(path: string) {
  const bytes = await readFile(path);
  return {
    type: 'image_url',
    image_url: { url: `data:${mimeOf(path)};base64,${bytes.toString('base64')}` },
  };
}

async function liveSamples(
  dir: string,
  version: PromptVersion,
  n: number,
): Promise<RawSample[]> {
  const apiKey = process.env['BEDROCK_API_KEY'];
  const model = process.env['BEDROCK_MODEL_ID'] ?? 'moonshotai.kimi-k2.5';
  if (apiKey === undefined || apiKey === '') throw new Error('BEDROCK_API_KEY is not set');

  const [before, after] = await Promise.all([
    imagePart(join(dir, 'before.jpg')),
    imagePart(join(dir, 'after.jpg')),
  ]);

  const body = JSON.stringify({
    model,
    messages: [
      { role: 'user', content: [before, after, { type: 'text', text: roomDiffPrompt(version) }] },
    ],
    max_tokens: 2048,
    temperature: 0,
  });

  const url = `${DEFAULT_BASE_URL.replace(/\/$/, '')}/chat/completions`;

  return Promise.all(
    Array.from({ length: n }, async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return { text: payload.choices?.[0]?.message?.content ?? '', source: 'live' as const };
    }),
  );
}

async function sampleCase(
  testCase: Case,
  version: PromptVersion,
  n: number,
  live: boolean,
): Promise<Sampling> {
  const recorded = await recordedSamples(testCase.dir, version);
  if (recorded !== undefined) return { ok: true, samples: recorded };

  if (!live) {
    return { ok: false, skipped: `no recorded responses for ${version}, and --live not set` };
  }
  if (!existsSync(join(testCase.dir, 'before.jpg')) || !existsSync(join(testCase.dir, 'after.jpg'))) {
    return { ok: false, skipped: 'before.jpg / after.jpg missing' };
  }
  try {
    return { ok: true, samples: await liveSamples(testCase.dir, version, n) };
  } catch (error) {
    return { ok: false, skipped: error instanceof Error ? error.message : 'live call failed' };
  }
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

function haystack(change: MergedChange): string {
  return `${change.description} ${change.location}`.toLowerCase();
}

function matches(change: MergedChange, truth: z.infer<typeof truthChangeSchema>): boolean {
  if (truth.surface !== undefined && change.surface !== truth.surface) return false;
  const text = haystack(change);
  return truth.keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

function hitsForbidden(change: MergedChange, truth: Truth): boolean {
  const text = haystack(change);
  return truth.forbidden.some((entry) =>
    entry.keywords.some((keyword) => text.includes(keyword.toLowerCase())),
  );
}

interface CaseScore {
  readonly id: string;
  readonly kind: Truth['kind'];
  readonly skipped?: string;
  readonly samplesRequested: number;
  readonly samplesParsed: number;
  readonly parseFailures: number;
  readonly fenced: number;
  readonly leadingWhitespace: number;
  readonly prose: number;
  readonly truthCount: number;
  readonly found: number;
  readonly reported: number;
  readonly falsePositives: number;
  readonly fabrications: number;
  readonly overCap: boolean;
  /**
   * Fewer recorded samples than k. The agreement bar is clamped to the number
   * of samples that exist, which makes the case *more* likely to report a
   * change, not less — the conservative direction for the headline metric.
   * Flagged so no one reads the row as a k-of-N result.
   */
  readonly underSampled: boolean;
  readonly effectiveK: number;
  /** Mean agreementFrequency across every cluster the model produced. */
  readonly meanAgreement: number;
  /** Clusters reported by every sample, as a fraction of all clusters. */
  readonly unanimity: number;
  readonly clusters: number;
  readonly survivors: readonly string[];
}

function scoreCase(
  testCase: Case,
  samples: readonly RawSample[],
  k: number,
): CaseScore {
  const parsed: WireDiffResult[] = [];
  const diagnostics: ParseDiagnostics[] = [];
  let parseFailures = 0;

  for (const sample of samples) {
    const outcome = parseModelResponse(sample.text);
    diagnostics.push(outcome.diagnostics);
    if (outcome.ok) parsed.push(outcome.value);
    else parseFailures += 1;
  }

  const effectiveK = Math.max(1, Math.min(k, samples.length));
  const merged: MergedRoomDiff =
    parsed.length > 0
      ? mergeSelfConsistent(parsed, { minAgreement: effectiveK })
      : { sampleCount: 0, minAgreement: effectiveK, changes: [], dropped: [] };

  const allClusters = [
    ...merged.changes.map((c) => c.agreementFrequency),
    ...merged.dropped.map((d) => d.agreementFrequency),
  ];

  const truth = testCase.truth;
  const found = truth.changes.filter((entry) =>
    merged.changes.some((change) => matches(change, entry)),
  ).length;
  const falsePositives = merged.changes.filter(
    (change) => !truth.changes.some((entry) => matches(change, entry)),
  ).length;
  const fabrications = merged.changes.filter((change) => hitsForbidden(change, truth)).length;

  return {
    id: testCase.id,
    kind: truth.kind,
    samplesRequested: samples.length,
    samplesParsed: parsed.length,
    parseFailures,
    fenced: diagnostics.filter((d) => d.hadCodeFence).length,
    leadingWhitespace: diagnostics.filter((d) => d.hadLeadingWhitespace).length,
    prose: diagnostics.filter((d) => d.hadProseBefore || d.hadProseAfter).length,
    truthCount: truth.changes.length,
    found,
    reported: merged.changes.length,
    falsePositives,
    fabrications,
    overCap: truth.maxChanges !== undefined && merged.changes.length > truth.maxChanges,
    underSampled: samples.length < k,
    effectiveK,
    meanAgreement:
      allClusters.length === 0 ? 0 : allClusters.reduce((a, b) => a + b, 0) / allClusters.length,
    unanimity:
      allClusters.length === 0 ? 0 : allClusters.filter((f) => f >= 1).length / allClusters.length,
    clusters: allClusters.length,
    survivors: merged.changes.map((c) => `${c.surface ?? 'UNSPECIFIED'}: ${c.description}`),
  };
}

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

interface VersionReport {
  readonly version: PromptVersion;
  readonly cases: readonly CaseScore[];
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return '  n/a';
  return `${((numerator / denominator) * 100).toFixed(0).padStart(4)}%`;
}

function aggregate(cases: readonly CaseScore[]) {
  const scored = cases.filter((c) => c.skipped === undefined);
  const sum = (pick: (c: CaseScore) => number) => scored.reduce((a, c) => a + pick(c), 0);
  const samples = sum((c) => c.samplesRequested);
  return {
    scored: scored.length,
    skipped: cases.length - scored.length,
    truth: sum((c) => c.truthCount),
    found: sum((c) => c.found),
    reported: sum((c) => c.reported),
    falsePositives: sum((c) => c.falsePositives),
    fabrications: sum((c) => c.fabrications),
    casesWithFp: scored.filter((c) => c.falsePositives > 0).length,
    samples,
    parseFailures: sum((c) => c.parseFailures),
    fenced: sum((c) => c.fenced),
    leadingWhitespace: sum((c) => c.leadingWhitespace),
    meanAgreement:
      scored.length === 0 ? 0 : sum((c) => c.meanAgreement * c.clusters) / Math.max(1, sum((c) => c.clusters)),
    unanimousClusters: sum((c) => c.unanimity * c.clusters),
    clusters: sum((c) => c.clusters),
  };
}

function printVersion(report: VersionReport, k: number, n: number): void {
  const a = aggregate(report.cases);
  console.log(`\n── prompt ${report.version} ─────────────────────────────────────────────`);
  console.log(`   N=${n}  k=${k}   cases scored: ${a.scored}   skipped: ${a.skipped}`);
  console.log('');
  console.log('   case                      kind            truth  found  reported  FP  fab  agree');
  console.log('   ────────────────────────  ──────────────  ─────  ─────  ────────  ──  ───  ─────');
  for (const c of report.cases) {
    if (c.skipped !== undefined) {
      console.log(`   ${c.id.padEnd(24)}  ${c.kind.padEnd(14)}  SKIPPED — ${c.skipped}`);
      continue;
    }
    console.log(
      `   ${c.id.padEnd(24)}  ${c.kind.padEnd(14)}  ${String(c.truthCount).padStart(5)}  ` +
        `${String(c.found).padStart(5)}  ${String(c.reported).padStart(8)}  ` +
        `${String(c.falsePositives).padStart(2)}  ${String(c.fabrications).padStart(3)}  ` +
        `${(c.meanAgreement * 100).toFixed(0).padStart(4)}%`,
    );
    if (c.underSampled) {
      console.log(
        `       ↳ UNDER-SAMPLED: ${c.samplesRequested} recorded response${c.samplesRequested === 1 ? '' : 's'}, ` +
          `so k was clamped to ${c.effectiveK}. Not a k-of-${c.samplesRequested} result.`,
      );
    }
    for (const survivor of c.survivors) console.log(`       ↳ ${survivor}`);
    if (c.overCap) console.log(`       ↳ OVER CAP: more changes reported than the answer key allows`);
  }

  console.log('');
  console.log(`   recall ................... ${pct(a.found, a.truth)}   (${a.found}/${a.truth} ground-truth changes found)`);
  console.log(`   FALSE-POSITIVE RATE ...... ${pct(a.falsePositives, a.reported)}   (${a.falsePositives}/${a.reported} reported changes were not real)   ← headline`);
  console.log(`   cases with any FP ........ ${pct(a.casesWithFp, a.scored)}   (${a.casesWithFp}/${a.scored} cases)`);
  console.log(`   fabrications ............. ${a.fabrications}   (hits on an explicit forbidden list)`);
  console.log(`   inter-run agreement ...... ${(a.meanAgreement * 100).toFixed(0).padStart(4)}%   (mean over ${a.clusters} clusters; ${a.unanimousClusters.toFixed(0)} unanimous)`);
  console.log(`   parse failure rate ....... ${pct(a.parseFailures, a.samples)}   (${a.parseFailures}/${a.samples} samples)`);
  console.log(`   fenced responses ......... ${pct(a.fenced, a.samples)}`);
  console.log(`   leading whitespace ....... ${pct(a.leadingWhitespace, a.samples)}`);
}

function printComparison(reports: readonly VersionReport[]): void {
  if (reports.length < 2) return;
  console.log('\n── v1 vs v2 ────────────────────────────────────────────────────');
  console.log('   version   recall   FP rate   fabs   parse fail   agreement');
  console.log('   ───────   ──────   ───────   ────   ──────────   ─────────');
  for (const report of reports) {
    const a = aggregate(report.cases);
    console.log(
      `   ${report.version.padEnd(7)}   ${pct(a.found, a.truth)}     ${pct(a.falsePositives, a.reported)}   ` +
        `${String(a.fabrications).padStart(4)}        ${pct(a.parseFailures, a.samples)}       ` +
        `${(a.meanAgreement * 100).toFixed(0).padStart(4)}%`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function loadCases(setDir: string): Promise<Case[]> {
  if (!existsSync(setDir)) return [];
  const entries = await readdir(setDir, { withFileTypes: true });
  const cases: Case[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(setDir, entry.name);
    const truthPath = join(dir, 'truth.json');
    if (!existsSync(truthPath)) continue;
    const parsed = truthSchema.safeParse(JSON.parse(await readFile(truthPath, 'utf8')));
    if (!parsed.success) {
      console.error(`   ! ${entry.name}/truth.json is invalid: ${parsed.error.issues[0]?.message}`);
      continue;
    }
    cases.push({ id: basename(dir), dir, truth: parsed.data });
  }
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

async function main(): Promise<void> {
  const setDir = arg('set') ?? DEFAULT_SET;
  const n = Number(arg('samples') ?? 5);
  const k = Number(arg('k') ?? 3);
  const live = process.argv.includes('--live');
  const versions = (arg('versions')?.split(',') ?? [...PROMPT_VERSIONS]).filter(isPromptVersion);

  console.log('Handover — diff eval (§9.5)');
  console.log(`golden set: ${setDir}`);
  console.log(`mode: ${live ? 'LIVE (will call the model)' : 'recorded responses only (pass --live to call the model)'}`);

  const cases = await loadCases(setDir);
  if (cases.length === 0) {
    console.log('\nNo cases found. The golden set is empty — this run proves nothing.');
    console.log('See eval/golden-set/README.md for the case format.');
    process.exit(0);
  }

  const reports: VersionReport[] = [];
  for (const version of versions) {
    const scores: CaseScore[] = [];
    for (const testCase of cases) {
      const sampling = await sampleCase(testCase, version, n, live);
      if (!sampling.ok) {
        scores.push({
          id: testCase.id,
          kind: testCase.truth.kind,
          skipped: sampling.skipped,
          samplesRequested: 0,
          samplesParsed: 0,
          parseFailures: 0,
          fenced: 0,
          leadingWhitespace: 0,
          prose: 0,
          truthCount: testCase.truth.changes.length,
          found: 0,
          reported: 0,
          falsePositives: 0,
          fabrications: 0,
          overCap: false,
          underSampled: false,
          effectiveK: k,
          meanAgreement: 0,
          unanimity: 0,
          clusters: 0,
          survivors: [],
        });
        continue;
      }
      scores.push(scoreCase(testCase, sampling.samples, k));
    }
    reports.push({ version, cases: scores });
    printVersion({ version, cases: scores }, k, n);
  }

  printComparison(reports);

  const totalScored = reports.reduce((sum, r) => sum + aggregate(r.cases).scored, 0);
  console.log('');
  if (cases.length < 20) {
    console.log(
      `⚠ The golden set holds ${cases.length} case${cases.length === 1 ? '' : 's'}. §9.5 asks for ≥20.`,
    );
    console.log('  These numbers characterise known failure modes. They are not a pass.');
  }
  if (totalScored === 0) {
    console.log('⚠ Nothing was scored. Every case was skipped.');
  }

  const jsonPath = arg('json');
  if (jsonPath !== undefined) {
    await writeFile(jsonPath, JSON.stringify({ n, k, reports }, null, 2));
    console.log(`\nwrote ${jsonPath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
