/**
 * Seed the state-rules table from `data/state-rules/*.json` (§9.2, AP-7).
 *
 * Run with the deploy environment set:
 *   TABLE_NAME=... AWS_REGION=ap-south-1 npx tsx src/adapters/seed-state-rules.ts
 *
 * The `_`-prefixed keys in the JSON are drafting notes for humans and are
 * stripped here — they document provenance in the file, which is where a
 * reviewer reads them, and have no business in the item the API serves.
 *
 * A file with no `lastReviewedAt` seeds without one. That is deliberate: the
 * absence travels all the way to the UI, which omits the "rules last reviewed"
 * line rather than implying a review that has not happened (R9).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { key } from '@handover/shared';
import type { StateRuleItem } from '@handover/shared';
import { putStateRule } from './dynamo/evidence-store.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../data/state-rules');

/** Drop the human-facing drafting notes. */
function stripNotes(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_')));
}

export function loadStateRule(stateCode: string): StateRuleItem {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, `${stateCode}.json`), 'utf8'));
  const fields = stripNotes(raw) as Omit<StateRuleItem, 'PK' | 'SK' | 'entityType' | 'updatedAt'>;

  return {
    ...key.stateRule(stateCode),
    entityType: 'STATE_RULE',
    ...fields,
    // A write timestamp, never a review timestamp. Conflating the two is
    // exactly the failure R9 is about.
    updatedAt: new Date().toISOString(),
  } as StateRuleItem;
}

export async function seedAll(): Promise<string[]> {
  const codes = readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));

  for (const code of codes) {
    const item = loadStateRule(code);
    await putStateRule(item);
    const reviewed = item.lastReviewedAt
      ? `last reviewed ${item.lastReviewedAt}`
      : 'NOT REVIEWED — lastReviewedAt absent';
    console.info(`seeded ${code}: ${item.stateName} (${reviewed})`);
  }
  return codes;
}

// Entry point when run directly.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*?(?=\/)/, ''))) {
  seedAll().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
