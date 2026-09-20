import { App } from 'aws-cdk-lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HANDOVER_REGION, REGION_CONTEXT_KEY, resolveEnv } from '../lib/env.js';

/**
 * The single-region rule — CLAUDE.md: "Region is `ap-south-1`. Single region,
 * always."
 *
 * This file exists because of a bug it would have caught. The entry point read
 * `process.env.CDK_DEFAULT_REGION ?? 'ap-south-1'`, and the fallback never
 * fired: the CDK CLI always sets that variable in the app's subprocess from
 * whatever ambient AWS configuration the machine has. Every stack synthesised
 * for `us-east-1`, including the evidence bucket — which is RETAIN and
 * delete-denied, so a wrong-region deploy leaves a bucket nobody meant to
 * create, holding photographs of someone's home, in a jurisdiction the product
 * did not choose.
 */

const ORIGINAL = { ...process.env };

beforeEach(() => {
  delete process.env['CDK_DEFAULT_REGION'];
  delete process.env['CDK_DEFAULT_ACCOUNT'];
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('resolveEnv — the region is pinned', () => {
  it('is ap-south-1 by default', () => {
    expect(resolveEnv(new App()).region).toBe('ap-south-1');
    expect(HANDOVER_REGION).toBe('ap-south-1');
  });

  it('ignores CDK_DEFAULT_REGION entirely', () => {
    // The regression. The CLI sets this on every invocation, so reading it
    // meant the deploy region was a property of the operator's laptop.
    process.env['CDK_DEFAULT_REGION'] = 'us-east-1';

    expect(resolveEnv(new App()).region).toBe('ap-south-1');
  });

  it('ignores it even when it names a plausible neighbour', () => {
    process.env['CDK_DEFAULT_REGION'] = 'ap-southeast-1';

    expect(resolveEnv(new App()).region).toBe('ap-south-1');
  });

  it('can still be overridden deliberately, at the command line', () => {
    // `cdk deploy -c handover:region=…` remains possible; the point is that
    // it is now an explicit act rather than ambient configuration.
    const app = new App({ context: { [REGION_CONTEXT_KEY]: 'eu-west-1' } });

    expect(resolveEnv(app).region).toBe('eu-west-1');
  });

  it('falls back to the constant when the context value is empty or wrong-typed', () => {
    for (const value of ['', '   ', 42, null]) {
      const app = new App({ context: { [REGION_CONTEXT_KEY]: value } });
      expect(resolveEnv(app).region).toBe('ap-south-1');
    }
  });
});

describe('resolveEnv — the account is never written down (§10.3)', () => {
  it('takes the account from the environment', () => {
    process.env['CDK_DEFAULT_ACCOUNT'] = '123456789012';

    expect(resolveEnv(new App()).account).toBe('123456789012');
  });

  it('leaves the account undefined when none is configured', () => {
    expect(resolveEnv(new App()).account).toBeUndefined();
  });

  it('holds no account id of its own', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../lib/env.ts', import.meta.url), 'utf8'),
    );

    expect(source).not.toMatch(/\b\d{12}\b/);
  });
});
