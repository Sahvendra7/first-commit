/**
 * The prompt version as the domain sees it: an opaque string that is part of
 * the cache key and the provenance of every result.
 *
 * Deliberately a separate, dependency-free declaration rather than an import
 * from `../../prompts/registry.js`. The registry reads files from disk at
 * module load; the domain must stay loadable and unit-testable with no
 * filesystem, so it takes the version as data and never resolves it to content.
 * The registry's `PromptVersion` is assignable to this type.
 */
export type PromptVersion = string;
