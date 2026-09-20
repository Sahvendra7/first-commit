/**
 * Prompt registry — architecture.md §9.3, CLAUDE.md ("Prompts are versioned
 * files ... never inline strings").
 *
 * Maps `promptVersion` → prompt content. The version string is what goes into
 * the cache key (`sha256(beforeHash + afterHash + promptVersion)`) and onto
 * every `DIFF` item, so editing a shipped prompt in place would silently serve
 * stale cache entries under a version that no longer describes them. Add a
 * version directory instead; the registry is the only place that needs to know.
 *
 * The prompts are real Markdown files on disk rather than string constants, so
 * they can be diffed, reviewed and compared by the eval as artifacts. They are
 * read once at module load.
 *
 * DEPLOYMENT NOTE: Lambda bundling must copy `src/prompts/**` into the bundle
 * alongside the JS. When the CDK stack lands, that is a `commandHooks.afterBundling`
 * copy step on the `diff-worker` NodejsFunction. Not wired up this session —
 * no Lambda is built yet — but the registry will throw loudly at cold start
 * rather than silently serving an empty prompt if it is forgotten.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Every prompt version that exists. Ordered oldest → newest. */
export const PROMPT_VERSIONS = ['v1', 'v2'] as const;
export type PromptVersion = (typeof PROMPT_VERSIONS)[number];

/**
 * The version the diff path uses by default. `v1` stays registered — and stays
 * byte-for-byte unmodified — purely so the eval can run both over the same
 * cases (§9.5) and so past `DIFF` items remain explicable.
 */
export const CURRENT_PROMPT_VERSION: PromptVersion = 'v2';

export function isPromptVersion(value: string): value is PromptVersion {
  return (PROMPT_VERSIONS as readonly string[]).includes(value);
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Leading HTML comment blocks are provenance for humans — what changed between
 * versions and which measured failure drove it. They are not instructions and
 * are not worth the tokens, so they are stripped before the prompt is sent.
 */
function stripLeadingComments(source: string): string {
  let rest = source.trimStart();
  while (rest.startsWith('<!--')) {
    const end = rest.indexOf('-->');
    if (end === -1) break;
    rest = rest.slice(end + 3).trimStart();
  }
  return rest;
}

function load(version: PromptVersion): string {
  const path = join(here, version, 'room-diff.md');
  const body = stripLeadingComments(readFileSync(path, 'utf8')).trim();
  if (body.length === 0) {
    throw new Error(`prompt ${version} loaded empty from ${path}`);
  }
  return body;
}

const ROOM_DIFF: Readonly<Record<PromptVersion, string>> = Object.freeze({
  v1: load('v1'),
  v2: load('v2'),
});

/** The room-diff prompt for a version. Throws on an unregistered version. */
export function roomDiffPrompt(version: PromptVersion): string {
  const prompt = ROOM_DIFF[version];
  if (prompt === undefined) {
    throw new Error(`unregistered promptVersion: ${String(version)}`);
  }
  return prompt;
}
