/**
 * `@handover/shared` — the frozen contract between `apps/web` and `apps/api`.
 * architecture.md §14; CLAUDE.md ("packages/shared is a frozen contract").
 *
 * Zero runtime dependencies other than Zod: this package is imported by both a
 * browser bundle and a Node 20 Lambda, so it may not reach for `node:` builtins
 * or anything platform-specific.
 */
export * from './constants/index.js';
export * from './types/index.js';
export * from './schemas/index.js';
