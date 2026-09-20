/**
 * The service worker's caching whitelist, exercised against the shipped file.
 *
 * `public/sw.js` is not a module — it is a classic worker script the browser
 * loads by URL, so it cannot be imported. Rather than duplicate its whitelist
 * here (where the copy would drift and the test would then be asserting
 * nothing), this evaluates the real file's `isCacheableAsset` in a sandbox with
 * the worker globals stubbed.
 *
 * What is being defended: an aggregate cached and redisplayed after the record
 * has moved on is stale evidence shown as current, and a cached presigned URL
 * is both a dead link after five minutes and a copy of someone's evidence left
 * in a browser cache that sign-out does not clear.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SW_PATH = resolve(HERE, '../../public/sw.js');

/**
 * Pulls `isCacheableAsset` out of the shipped worker.
 *
 * The listener registrations are the only part of the file that needs a real
 * worker scope, and a stubbed `self` with a no-op `addEventListener` satisfies
 * them without executing any of the handlers.
 */
function loadPredicate(origin: string): (url: URL) => boolean {
  const source = readFileSync(SW_PATH, 'utf8');
  const sandbox = {
    location: new URL(origin),
    addEventListener: () => {},
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };
  const factory = new Function(
    'self',
    'caches',
    'URL',
    'Response',
    `${source}\nreturn isCacheableAsset;`,
  );
  return factory(sandbox, { open: () => {}, keys: () => {}, match: () => {} }, URL, class {}) as (
    url: URL,
  ) => boolean;
}

const ORIGIN = 'https://handover.example';
const isCacheableAsset = loadPredicate(ORIGIN);

describe('service worker — what it will cache', () => {
  it('caches hashed build output', () => {
    expect(isCacheableAsset(new URL('/assets/index-abc123.js', ORIGIN))).toBe(true);
    expect(isCacheableAsset(new URL('/assets/index-abc123.css', ORIGIN))).toBe(true);
  });

  it('caches the icons and the manifest', () => {
    expect(isCacheableAsset(new URL('/icons/icon-192.png', ORIGIN))).toBe(true);
    expect(isCacheableAsset(new URL('/manifest.json', ORIGIN))).toBe(true);
  });
});

describe('service worker — what it must never cache', () => {
  it('never caches a tenancy aggregate', () => {
    expect(isCacheableAsset(new URL('/v1/tenancies/ten_1', ORIGIN))).toBe(false);
  });

  it('never caches a diff', () => {
    expect(isCacheableAsset(new URL('/v1/tenancies/ten_1/diff', ORIGIN))).toBe(false);
  });

  it('never caches a job status', () => {
    expect(isCacheableAsset(new URL('/v1/jobs/job_1', ORIGIN))).toBe(false);
  });

  it('never caches the state-rules response, public though it is', () => {
    // Cacheable in principle, but not by this worker: one whitelist, no
    // exceptions, so there is nothing to get wrong later.
    expect(isCacheableAsset(new URL('/v1/state-rules/KA', ORIGIN))).toBe(false);
  });

  it('never caches an API on a different origin', () => {
    expect(
      isCacheableAsset(new URL('https://abc.execute-api.ap-south-1.amazonaws.com/v1/tenancies/t')),
    ).toBe(false);
  });

  it('never caches a presigned S3 evidence URL', () => {
    expect(
      isCacheableAsset(
        new URL('https://handover-evidence.s3.ap-south-1.amazonaws.com/tenancies/t/p.jpg?sig=x'),
      ),
    ).toBe(false);
  });

  it('never caches a presigned document URL', () => {
    expect(
      isCacheableAsset(
        new URL('https://handover-documents.s3.ap-south-1.amazonaws.com/tenancies/t/d.pdf?sig=x'),
      ),
    ).toBe(false);
  });

  it('never caches a same-origin asset path carrying a query string', () => {
    // A query is how a signed or parameterised request is spelled. An asset
    // path with one is not the immutable file the whitelist assumes.
    expect(isCacheableAsset(new URL('/assets/index-abc123.js?token=secret', ORIGIN))).toBe(false);
  });

  it('never caches an arbitrary same-origin path outside the whitelist', () => {
    expect(isCacheableAsset(new URL('/v1/anything', ORIGIN))).toBe(false);
    expect(isCacheableAsset(new URL('/some/other/path', ORIGIN))).toBe(false);
  });
});

describe('service worker — source-level guarantees', () => {
  const source = readFileSync(SW_PATH, 'utf8');

  it('only ever handles GET', () => {
    expect(source).toContain("request.method !== 'GET'");
  });

  it('caches the shell only, with no tenancy path precached', () => {
    expect(source).not.toMatch(/SHELL\s*=\s*\[[^\]]*v1/);
  });
});
