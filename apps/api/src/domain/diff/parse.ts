/**
 * Validate-and-repair parsing of a model response — architecture.md §9.3.
 *
 * On the provisional bedrock-mantle Chat Completions endpoint (§9.1) there is
 * no tool-use and therefore no schema-constrained output. This module is the
 * entire output contract, and the tolerances below are measured rather than
 * imagined: across sampled runs on real photograph pairs, **every** response
 * carried leading whitespace and **one in four** wrapped the JSON in a fence.
 *
 * The repairs here are strictly syntactic — find the object, normalise the
 * spelling of an enum, supply `OTHER` for an absent `type`. Nothing in this
 * file invents an observation, a location or a confidence. A response that
 * does not contain a valid change list produces a typed failure, and the
 * caller retries exactly once before marking the room `NEEDS_REVIEW` (§9.6).
 *
 * Domain module: no AWS imports, no I/O, no clock. Pure string in, result out.
 */

import { z } from 'zod';
import { diffChangeSchema } from '@handover/shared';

/**
 * What the model is asked to emit, per change.
 *
 * Derived from the frozen `diffChangeSchema` rather than redeclared, so the
 * wire shape cannot drift from the stored shape. Three fields are omitted
 * because they are code's to assign, not the model's (§9.2):
 *   - `id`      — identity is code's job; the merge mints a stable one
 *   - `source`  — provenance is tracked in `human-edits.ts`
 *   - `tenantAction` — only a human writes that
 */
export const wireChangeSchema = diffChangeSchema.omit({
  id: true,
  source: true,
  tenantAction: true,
});
export type WireChange = z.infer<typeof wireChangeSchema>;

/**
 * The lenient variant exists for one purpose: the eval compares prompt `v1`
 * against `v2` on identical cases (§9.5), and `v1`'s output template never
 * asked for `location`. Under the strict schema every `v1` response is a
 * schema failure, which is a true finding but makes the recall comparison
 * vacuous. The eval parses `v1` leniently so the comparison measures
 * perception rather than a template omission, and reports both numbers.
 *
 * **Never used in the diff path.** A change nobody can locate in the room is
 * not a change anybody can put in a letter.
 */
export const lenientWireChangeSchema = wireChangeSchema.partial({ location: true });

const diffBody = <T extends z.ZodTypeAny>(change: T) =>
  z.object({
    changes: z.array(change).max(50, 'implausible change count — treat as a failed generation'),
    note: z.string().max(600).optional(),
  });

export const wireDiffResultSchema = diffBody(wireChangeSchema);
export type WireDiffResult = z.infer<typeof wireDiffResultSchema>;

const lenientDiffResultSchema = diffBody(lenientWireChangeSchema);

/**
 * Output-contract health, recorded whether the parse succeeded or failed. The
 * eval aggregates these into the fence/whitespace incidence figures that
 * justified this module existing.
 */
export interface ParseDiagnostics {
  readonly rawLength: number;
  readonly hadLeadingWhitespace: boolean;
  readonly hadTrailingWhitespace: boolean;
  readonly hadCodeFence: boolean;
  readonly hadProseBefore: boolean;
  readonly hadProseAfter: boolean;
}

export type ParseFailureReason =
  /** Nothing object-shaped in the response at all — prose, refusal, or empty. */
  | 'NO_JSON_OBJECT'
  /** An object started but never closed, or did not parse as JSON. */
  | 'MALFORMED_JSON'
  /** Valid JSON, wrong shape. */
  | 'SCHEMA_INVALID';

export type ParseOutcome =
  | { readonly ok: true; readonly value: WireDiffResult; readonly diagnostics: ParseDiagnostics }
  | {
      readonly ok: false;
      readonly reason: ParseFailureReason;
      readonly detail: string;
      readonly diagnostics: ParseDiagnostics;
    };

export interface ParseOptions {
  /** Eval-only (see `lenientWireChangeSchema`). Defaults to false. */
  readonly lenient?: boolean;
}

/**
 * Scan for the first *balanced* top-level object, tracking string state so a
 * brace inside a description does not end the object early. Returns the
 * substring, or a reason it could not.
 */
function extractFirstJsonObject(
  raw: string,
): { start: number; end: number; text: string } | { failure: ParseFailureReason } {
  const start = raw.indexOf('{');
  if (start === -1) return { failure: 'NO_JSON_OBJECT' };

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return { start, end: i + 1, text: raw.slice(start, i + 1) };
      }
    }
  }

  // An object began and never closed: truncation, not absence.
  return { failure: 'MALFORMED_JSON' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `fixed fitting` / `fixed-fitting` / `Fixed_Fitting` all mean `FIXED_FITTING`. */
function normaliseEnumWord(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

/**
 * Syntactic repair only. The one semantic default is `type: OTHER` for an
 * absent type, which asserts nothing the model did not: it is the schema's own
 * "some other kind of change".
 */
function repair(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value['changes'])) return value;

  const changes = value['changes'].map((entry) => {
    if (!isRecord(entry)) return entry;
    const out: Record<string, unknown> = { ...entry };

    const type = out['type'];
    out['type'] =
      typeof type === 'string' && type.trim() !== '' ? normaliseEnumWord(type) : 'OTHER';

    const surface = out['surface'];
    if (typeof surface === 'string') {
      const normalised = normaliseEnumWord(surface);
      if (normalised === '') delete out['surface'];
      else out['surface'] = normalised;
    }

    return out;
  });

  return { ...value, changes };
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Parse one raw model response into a validated change list, or a typed
 * failure the caller can act on.
 */
export function parseModelResponse(raw: string, options: ParseOptions = {}): ParseOutcome {
  const trimmed = raw.trim();
  const found = extractFirstJsonObject(raw);

  const baseDiagnostics = {
    rawLength: raw.length,
    hadLeadingWhitespace: raw.length > 0 && raw !== raw.trimStart(),
    hadTrailingWhitespace: raw.length > 0 && raw !== raw.trimEnd(),
    hadCodeFence: trimmed.includes('```'),
  };

  if ('failure' in found) {
    return {
      ok: false,
      reason: found.failure,
      detail:
        found.failure === 'NO_JSON_OBJECT'
          ? 'response contained no JSON object'
          : 'JSON object was never closed',
      diagnostics: { ...baseDiagnostics, hadProseBefore: false, hadProseAfter: false },
    };
  }

  // Prose is anything either side of the object that is not whitespace and not
  // fence punctuation. Counted so the eval can report contract breakage.
  const before = raw.slice(0, found.start).replace(/```[a-z]*/gi, '').trim();
  const after = raw.slice(found.end).replace(/```/g, '').trim();
  const diagnostics: ParseDiagnostics = {
    ...baseDiagnostics,
    hadProseBefore: before.length > 0,
    hadProseAfter: after.length > 0,
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(found.text);
  } catch (error) {
    return {
      ok: false,
      reason: 'MALFORMED_JSON',
      detail: error instanceof Error ? error.message : 'unparseable JSON',
      diagnostics,
    };
  }

  const schema = options.lenient === true ? lenientDiffResultSchema : wireDiffResultSchema;
  const validated = schema.safeParse(repair(parsed));

  if (!validated.success) {
    return {
      ok: false,
      reason: 'SCHEMA_INVALID',
      detail: describeIssues(validated.error),
      diagnostics,
    };
  }

  return { ok: true, value: validated.data as WireDiffResult, diagnostics };
}
