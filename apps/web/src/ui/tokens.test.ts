/**
 * Every colour utility in the app resolves to a real design token.
 *
 * This test exists because of a bug it would have caught immediately. The
 * config defined the token as `surface.sunk`, which Tailwind emits as
 * `bg-surface-sunk` — but six components had been written against `bg-sunk`.
 * Tailwind does not warn about a class it has never heard of: it emits
 * nothing, the element falls back to transparent, and on a pale page the
 * result looks *almost* right. Nothing failed. The document card's sheet
 * glyph rendered as a black rectangle and everything else silently lost its
 * surface.
 *
 * A typo'd colour class is invisible to `tsc` and to every component test,
 * so it gets its own check: scan the source for colour utilities whose first
 * segment is one of our palette roots, and assert the whole name is a key the
 * config actually defines.
 *
 * It deliberately ignores Tailwind's own palette (`white`, `transparent`,
 * `current`) and anything whose root is not ours — those are not this
 * system's to police.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');
const CONFIG = resolve(HERE, '../../tailwind.config.js');

/**
 * The colour class suffixes Tailwind will emit, read out of the config.
 *
 * Read as text rather than imported: the config is a plain `.js` module with
 * no declarations, so importing it is an implicit `any` that `tsc` rejects,
 * and the shape being asserted here is a *naming* rule — `paper.deep` becomes
 * `paper-deep`, `DEFAULT` becomes the bare root — which is exactly what the
 * parse below models.
 */
function tokenNames(): ReadonlySet<string> {
  const source = readFileSync(CONFIG, 'utf8');
  // Start *after* the opening brace: including it would open a group called
  // `colors` and prefix every top-level token with it.
  const OPEN = 'colors: {';
  const block = source.slice(source.indexOf(OPEN) + OPEN.length, source.indexOf('fontFamily:'));
  const names = new Set<string>();

  let group: string | undefined;
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;

    // `paper: { DEFAULT: token('paper'), deep: token('paper-deep') },` — one line.
    const inline = /^([A-Za-z0-9]+):\s*\{(.+)\},?$/.exec(line);
    if (inline) {
      for (const key of inline[2]!.matchAll(/([A-Za-z0-9]+):\s*token\(/g)) {
        names.add(key[1] === 'DEFAULT' ? inline[1]! : `${inline[1]}-${key[1]}`);
      }
      continue;
    }

    // A group opened on its own line, and its members on the lines after it.
    const opens = /^([A-Za-z0-9]+):\s*\{$/.exec(line);
    if (opens) {
      group = opens[1]!;
      continue;
    }
    if (line.startsWith('}')) {
      group = undefined;
      continue;
    }

    const member = /^([A-Za-z0-9]+):\s*token\(/.exec(line);
    if (!member) continue;
    names.add(
      group === undefined
        ? member[1]!
        : member[1] === 'DEFAULT'
          ? group
          : `${group}-${member[1]}`,
    );
  }

  return names;
}

const TOKENS = tokenNames();

/** The first segment of every token — what marks a class as ours to check. */
const ROOTS = new Set([...TOKENS].map((name) => name.split('-')[0]));

/**
 * Colour-carrying utility prefixes, with the optional side/axis suffix that
 * `border-l-…` and friends put between the prefix and the colour.
 */
const UTILITY =
  /\b(?:bg|text|border|ring|outline|fill|stroke|divide|from|via|to|shadow|accent|caret|decoration)-(?:[trblxyse]-)?([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

describe('design tokens', () => {
  it('defines every colour the palette promises', () => {
    for (const name of ['paper', 'sunk', 'surface', 'ink', 'ink-3', 'brand', 'brand-tint', 'accent', 'ok', 'warn', 'danger', 'night']) {
      expect(TOKENS.has(name), `${name} is missing from the palette`).toBe(true);
    }
  });

  it('uses no colour class the config cannot emit', () => {
    const unknown = new Map<string, string[]>();

    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(UTILITY)) {
        const name = match[1]!;
        const root = name.split('-')[0]!;
        // Not one of ours: Tailwind's own scale, or a non-colour utility that
        // happens to share a prefix (`bg-gradient-to-b`, `divide-y`).
        if (!ROOTS.has(root)) continue;
        if (TOKENS.has(name)) continue;
        const where = unknown.get(name) ?? [];
        where.push(file.slice(SRC.length + 1));
        unknown.set(name, where);
      }
    }

    expect(
      Object.fromEntries([...unknown].map(([name, files]) => [name, [...new Set(files)]])),
    ).toEqual({});
  });
});
