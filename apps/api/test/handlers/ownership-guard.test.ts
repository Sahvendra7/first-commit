import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * §10.2: "The ownership check is the entire authorization model and is
 * therefore unit-tested with an explicit 'every route calls the guard'
 * assertion."
 *
 * This is that assertion. It is a source-level check rather than a behavioural
 * one on purpose: a behavioural test can only cover the routes someone
 * remembered to write a test for, and the failure being defended against is
 * precisely the route nobody remembered. A new file in `handlers/http/` that
 * forgets `assertOwnership` fails this test the moment it is added.
 *
 * §10.1's first threat is cross-tenant data access. There are no roles to get
 * wrong here — there is only this one call, present or absent.
 */

const HTTP_DIR = join(import.meta.dirname, '../../src/handlers/http');

/**
 * `http.ts` is plumbing, not a route. `create-tenancy.ts` creates the tenancy
 * that ownership is later asserted against, so it has nothing to assert
 * against yet — it sets `ownerSub` from the verified token instead, which this
 * test checks separately below.
 */
const NOT_ROUTES = new Set(['http.ts']);
const CREATES_OWNERSHIP = new Set(['create-tenancy.ts']);

const routeFiles = (): string[] =>
  readdirSync(HTTP_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .filter((f) => !NOT_ROUTES.has(f));

const source = (file: string): string => readFileSync(join(HTTP_DIR, file), 'utf8');

describe('every route calls the ownership guard (§10.2)', () => {
  it('finds the route files at all, so an empty glob cannot pass vacuously', () => {
    const routes = routeFiles();
    expect(routes.length).toBeGreaterThanOrEqual(4);
    expect(routes).toContain('presign-photos.ts');
    expect(routes).toContain('complete-phase.ts');
    expect(routes).toContain('get-tenancy.ts');
    expect(routes).toContain('get-diff.ts');
  });

  it.each(routeFiles().filter((f) => !CREATES_OWNERSHIP.has(f)))(
    '%s calls assertOwnership',
    (file) => {
      expect(source(file)).toContain('assertOwnership(');
    },
  );

  it.each(routeFiles())('%s takes the caller from verified JWT claims', (file) => {
    expect(source(file)).toContain('callerSub(event)');
  });

  /**
   * §7 and §10.1: no endpoint accepts an owner id from the client. A handler
   * that reads `ownerSub` out of a body or a query string would defeat the
   * guard while still calling it.
   */
  it.each(routeFiles())('%s never reads an owner id from the request', (file) => {
    const text = source(file);
    expect(text).not.toMatch(/body\s*\.\s*ownerSub/);
    expect(text).not.toMatch(/queryStringParameters\s*(\?\.|\[)\s*['"]?ownerSub/);
    expect(text).not.toMatch(/headers\s*(\?\.|\[)\s*['"]?x-owner/i);
  });

  it('create-tenancy sets ownerSub from the token, not from the body', () => {
    const text = source('create-tenancy.ts');
    expect(text).toContain('ownerSub: sub');
    expect(text).toContain('callerSub(event)');
  });
});

describe('callerSub is the only source of a caller identity', () => {
  it('is the single place that reads a JWT claim', () => {
    const readers = readdirSync(HTTP_DIR)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => source(f).includes('authorizer'));
    expect(readers).toEqual(['http.ts']);
  });
});
