/**
 * The diff cache key — architecture.md §5.5, §9.4.
 *
 * `sha256(beforeHash + afterHash + promptVersion)`, exactly as §5.5 specifies
 * it. Three properties fall out of that construction, and all three are the
 * reason it is a hash of those three things and not of anything else:
 *
 *  - **Content addressed.** The inputs are the stored photographs' own SHA-256
 *    digests, which `photo-ingest` computed by streaming the objects. Two runs
 *    over the same pair produce the same key without reading a byte of image.
 *  - **A prompt change invalidates the cache by construction.** `promptVersion`
 *    is part of the digest, so `v2` cannot serve a `v1` result. That is why
 *    §9.3 forbids editing a shipped prompt in place: the version string is the
 *    only thing keeping a cached answer honest about what produced it.
 *  - **Nothing identifying is in it.** No tenancy id, no room id, no owner.
 *    A cache entry is a statement about two images and a prompt, so the same
 *    pair photographed by two tenants shares an entry and neither learns
 *    anything about the other.
 *
 * Lives in `adapters/` rather than `domain/` because it needs a hash function:
 * the domain takes the resulting key as data and never computes one, the same
 * separation `adapters/job-id.ts` makes.
 */
import { createHash } from 'node:crypto';
import type { PromptVersion } from '../domain/diff/prompt-version.js';

/**
 * Hex digest of the two photo hashes and the prompt version.
 *
 * The separator matters: without one, `("ab","cd")` and `("a","bcd")` hash
 * identically, and the two would then share a cached change list. The photo
 * digests are fixed-width so this cannot arise from them today, but the key is
 * built to be unambiguous rather than to rely on that staying true.
 */
export function diffCacheKey(
  beforeSha256: string,
  afterSha256: string,
  promptVersion: PromptVersion,
): string {
  return createHash('sha256')
    .update(`${beforeSha256}|${afterSha256}|${promptVersion}`)
    .digest('hex');
}
