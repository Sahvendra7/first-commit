/**
 * `@handover/api` is a deployment unit, not a library — nothing outside this
 * workspace imports it at runtime. This entry point exists only so the eval
 * harness can reach the diff domain and the prompt registry through the
 * package name rather than a relative path across workspace roots.
 *
 * Deliberately narrow: the domain modules the eval scores, and the prompts it
 * compares. Handlers and adapters are not re-exported here.
 */
export * from './domain/diff/parse.js';
export * from './domain/diff/merge.js';
export * from './domain/diff/human-edits.js';
export type * from './domain/diff/port.js';
export * from './prompts/registry.js';
