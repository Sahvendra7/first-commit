import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuthStack } from '../lib/auth-stack.js';
import { ApiStack } from '../lib/api-stack.js';

/**
 * `api-stack` — the routing and authorization facts, asserted against the
 * synthesised template.
 *
 * The load-bearing assertion in this file is the **public route**. §5.2 makes
 * `GET /v1/state-rules/{code}` the single exception to the JWT authorizer, and
 * an exception to an authorization model is exactly the kind of thing that
 * gets copied to a second route by accident. So this file pins both halves:
 * that the state-rules route really is `NONE`, and that **every other route is
 * not** — the second half is the one that catches the accident.
 */

let template: Template;
/** Where this test's app staged its assets, so the bundle can be inspected. */
let outdir: string;

interface SynthesisedRoute {
  Properties: { RouteKey: string; AuthorizationType?: string; AuthorizerId?: unknown };
}

const routes = (): SynthesisedRoute[] =>
  Object.values(template.findResources('AWS::ApiGatewayV2::Route')) as SynthesisedRoute[];

const routeFor = (routeKey: string): SynthesisedRoute => {
  const found = routes().find((r) => r.Properties.RouteKey === routeKey);
  if (!found) throw new Error(`No route ${routeKey}. Found: ${routes().map((r) => r.Properties.RouteKey).join(', ')}`);
  return found;
};

beforeAll(() => {
  // An explicit outdir so the synthesised Lambda bundles land somewhere this
  // file can read them back — the prompt-bundling assertion below needs the
  // staged asset directory, not just the template.
  outdir = mkdtempSync(join(tmpdir(), 'handover-cdk-test-'));
  const app = new App({ outdir });
  const env = { account: '123456789012', region: 'ap-south-1' };
  const auth = new AuthStack(app, 'TestAuth', { env });
  const api = new ApiStack(app, 'TestApi', {
    env,
    tableName: 'test-table',
    evidenceBucketName: 'test-evidence',
    documentsBucketName: 'test-documents',
    userPool: auth.userPool,
    userPoolClient: auth.userPoolClient,
  });
  template = Template.fromStack(api);
});

describe('routes', () => {
  it.each([
    'POST /v1/tenancies',
    'GET /v1/tenancies/{id}',
    'POST /v1/tenancies/{id}/photos:presign',
    'POST /v1/tenancies/{id}/phases/{phase}/complete',
    'GET /v1/tenancies/{id}/diff',
    'PATCH /v1/tenancies/{id}/diff/{roomId}',
    'GET /v1/jobs/{jobId}',
    'GET /v1/state-rules/{code}',
  ])('exposes %s', (routeKey) => {
    expect(routeFor(routeKey)).toBeDefined();
  });
});

describe('authorization (§5.2, §10.2)', () => {
  /**
   * The whole point of the route existing. A regression here is invisible in
   * every other test and in the UI: the frontend would simply stop being able
   * to render deadline copy for a signed-out visitor.
   */
  it('makes the state-rules route public — no JWT authorizer', () => {
    const route = routeFor('GET /v1/state-rules/{code}');
    expect(route.Properties.AuthorizationType).toBe('NONE');
    expect(route.Properties.AuthorizerId).toBeUndefined();
  });

  /**
   * The mirror assertion, and the more important one. `NONE` on any route that
   * touches a tenancy is a cross-tenant read with nobody to check it against.
   */
  it('leaves every other route behind the JWT authorizer', () => {
    const unprotected = routes()
      .filter((r) => r.Properties.RouteKey !== 'GET /v1/state-rules/{code}')
      .filter((r) => r.Properties.AuthorizationType !== 'JWT')
      .map((r) => r.Properties.RouteKey);

    expect(unprotected).toEqual([]);
  });

  it('protects every tenancy-scoped route specifically', () => {
    for (const routeKey of [
      'POST /v1/tenancies',
      'GET /v1/tenancies/{id}',
      'POST /v1/tenancies/{id}/photos:presign',
      'POST /v1/tenancies/{id}/phases/{phase}/complete',
      'GET /v1/tenancies/{id}/diff',
      'PATCH /v1/tenancies/{id}/diff/{roomId}',
      'GET /v1/jobs/{jobId}',
    ]) {
      expect(routeFor(routeKey).Properties.AuthorizationType).toBe('JWT');
    }
  });

  it('declares exactly one JWT authorizer, on the Cognito issuer', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
      IdentitySource: ['$request.header.Authorization'],
    });
  });
});

describe('runtime defaults (§12, §13.3)', () => {
  it('runs every function on Node 20, ARM64', () => {
    const functions = Object.values(template.findResources('AWS::Lambda::Function')) as {
      Properties: { Runtime?: string; Architectures?: string[] };
    }[];

    // The CDK-managed bucket-notifications handler is not ours and is pinned
    // to its own runtime by the library, so it is excluded by construction.
    const ours = functions.filter((f) => f.Properties.Runtime === 'nodejs20.x');
    expect(ours.length).toBeGreaterThanOrEqual(7);
    for (const f of ours) {
      expect(f.Properties.Architectures).toEqual(['arm64']);
    }
  });
});

/** The actions on one function's default role policy, flattened. */
const actionsFor = (logicalIdPrefix: string): string[] => {
  const entry = Object.entries(template.findResources('AWS::IAM::Policy')).find(([id]) =>
    id.startsWith(`${logicalIdPrefix}ServiceRoleDefaultPolicy`),
  );
  if (!entry) throw new Error(`No default policy for ${logicalIdPrefix}`);
  const statements = (
    entry[1] as { Properties: { PolicyDocument: { Statement: { Action?: string | string[] }[] } } }
  ).Properties.PolicyDocument.Statement;
  return statements.flatMap((s) =>
    s.Action === undefined ? [] : Array.isArray(s.Action) ? s.Action : [s.Action],
  );
};

describe('least privilege (§10.3)', () => {
  /**
   * §10.3, verbatim: "`api-handler` — `s3:PutObject` on a prefix (for presign)
   * but **not** `s3:GetObject`."
   *
   * Splitting `api-handler` into one function per route is what makes that
   * sentence enforceable at all. A single function serving both presign and
   * the read paths would need the union of these two grants, and §10.3's
   * distinction would become undeployable. This test is the reason the split
   * is kept.
   */
  it('gives the presign function PutObject and never GetObject', () => {
    const actions = actionsFor('PresignPhotosFn');
    expect(actions).toContain('s3:PutObject');
    expect(actions.filter((a) => a.startsWith('s3:Get'))).toEqual([]);
  });

  it('gives the functions that sign download URLs GetObject and never PutObject', () => {
    for (const fn of ['GetTenancyFn', 'GetDiffFn']) {
      const actions = actionsFor(fn);
      expect(actions).toContain('s3:GetObject');
      expect(actions).not.toContain('s3:PutObject');
    }
  });

  it('gives the functions that touch no object storage no S3 grant at all', () => {
    for (const fn of ['CreateTenancyFn', 'CompletePhaseFn', 'PatchDiffFn', 'GetJobFn']) {
      expect(actionsFor(fn).filter((a) => a.startsWith('s3:'))).toEqual([]);
    }
  });

  /**
   * The public route is unauthenticated, so what its role can do is what an
   * anonymous caller can ultimately cause. Read-only on the table is the
   * boundary; a write grant here would be a hole with no ownership check in
   * front of it.
   */
  it('grants the public state-rules function no table write and no S3', () => {
    const actions = actionsFor('GetStateRulesFn');

    expect(actions).toContain('dynamodb:GetItem');
    for (const write of [
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
      'dynamodb:BatchWriteItem',
    ]) {
      expect(actions).not.toContain(write);
    }
    expect(actions.filter((a) => a.startsWith('s3:'))).toEqual([]);
  });

  /** No function in this stack may delete evidence, whatever else it can do. */
  it('grants no function any object-delete action', () => {
    const everything = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    for (const action of ['s3:DeleteObject', 's3:DeleteObjectVersion', 's3:PutBucketVersioning']) {
      expect(everything).not.toContain(action);
    }
  });
});

describe('diff-worker (§5.5, §9.1, §10.3)', () => {
  const diffWorker = (): { Properties: Record<string, unknown> } => {
    const entry = Object.entries(template.findResources('AWS::Lambda::Function')).find(([id]) =>
      id.startsWith('DiffWorkerFn'),
    );
    if (!entry) throw new Error('No DiffWorkerFn in the template');
    return entry[1] as { Properties: Record<string, unknown> };
  };

  it('is sized as §5.5 specifies: 300s, 1024 MB', () => {
    const props = diffWorker().Properties;
    expect(props['Timeout']).toBe(300);
    expect(props['MemorySize']).toBe(1024);
  });

  it('runs on Node 20, ARM64, like every other function', () => {
    const props = diffWorker().Properties;
    expect(props['Runtime']).toBe('nodejs20.x');
    expect(props['Architectures']).toEqual(['arm64']);
  });

  it('is not exposed as an HTTP route — it is invoked, never called', () => {
    const keys = routes().map((r) => r.Properties.RouteKey);
    expect(keys.some((k) => k.toLowerCase().includes('diff-worker'))).toBe(false);
    expect(keys.some((k) => k.toLowerCase().includes('worker'))).toBe(false);
  });

  it('reads evidence and writes the table, and nothing else touches S3 writes', () => {
    const actions = actionsFor('DiffWorkerFn');
    // `grantRead` emits `s3:GetObject*`, so match the prefix rather than the
    // exact action — the same shape `photo-ingest` carries.
    expect(actions.some((a) => a.startsWith('s3:GetObject'))).toBe(true);
    expect(actions.filter((a) => a.startsWith('s3:Put'))).toEqual([]);
    expect(actions).toContain('dynamodb:PutItem');
  });

  it('reads its model id and feature flag from SSM, and its key from Secrets Manager', () => {
    const actions = actionsFor('DiffWorkerFn');
    expect(actions).toContain('ssm:GetParameter');
    expect(actions).toContain('secretsmanager:GetSecretValue');
  });

  /**
   * §9.1: `bedrock-runtime` is unauthorised on this account, so the diff path
   * goes over HTTPS to bedrock-mantle. Granting `bedrock:InvokeModel` anyway —
   * because an IAM table lists it — would be a permission the code cannot use,
   * which is the wildcard-by-another-name §10.3 forbids. The grant arrives
   * with the Converse adapter that needs it, not before.
   */
  it('holds no Bedrock permission it cannot use', () => {
    expect(JSON.stringify(template.findResources('AWS::IAM::Policy'))).not.toContain('bedrock:');
  });

  it('is invokable by complete-phase, and by no other HTTP function', () => {
    // `diff-worker` also holds an invoke grant — for `doc-worker`, not for
    // itself — so the assertion is about which *HTTP* functions may dispatch.
    const httpInvokers = Object.entries(template.findResources('AWS::IAM::Policy'))
      .filter(([, policy]) => JSON.stringify(policy).includes('lambda:InvokeFunction'))
      .map(([id]) => id)
      .filter((id) => !id.startsWith('DiffWorkerFn'));

    expect(httpInvokers).toHaveLength(1);
    expect(httpInvokers[0]).toMatch(/^CompletePhaseFn/);
  });

  it('tells complete-phase which function to invoke', () => {
    const complete = Object.entries(template.findResources('AWS::Lambda::Function')).find(([id]) =>
      id.startsWith('CompletePhaseFn'),
    );
    const env = (complete?.[1] as { Properties: { Environment?: { Variables?: Record<string, unknown> } } })
      .Properties.Environment?.Variables;

    expect(env).toHaveProperty('DIFF_WORKER_FUNCTION_NAME');
  });

  /**
   * The prompts are Markdown read from disk at cold start (§9.3). esbuild
   * bundles JavaScript only, so without the `afterBundling` copy the function
   * deploys cleanly and then throws on its first invocation — the kind of
   * failure that only shows up in the deployed environment.
   */
  it('ships the prompt files in the worker bundle', () => {
    const asset = (diffWorker().Properties['Code'] as { S3Key: string }).S3Key;
    const hash = asset.split('.')[0];
    const dir = join(outdir, `asset.${hash}`);

    expect(existsSync(join(dir, 'prompts', 'v1', 'room-diff.md'))).toBe(true);
    expect(existsSync(join(dir, 'prompts', 'v2', 'room-diff.md'))).toBe(true);
  });
});

describe('doc-worker (§5.6, §10.3)', () => {
  const docWorker = (): { Properties: Record<string, unknown> } => {
    const entry = Object.entries(template.findResources('AWS::Lambda::Function')).find(([id]) =>
      id.startsWith('DocWorkerFn'),
    );
    if (!entry) throw new Error('No DocWorkerFn in the template');
    return entry[1] as { Properties: Record<string, unknown> };
  };

  it('runs on Node 20, ARM64', () => {
    const props = docWorker().Properties;
    expect(props['Runtime']).toBe('nodejs20.x');
    expect(props['Architectures']).toEqual(['arm64']);
  });

  it('reads evidence and writes documents, never the other way round', () => {
    const statements = (
      Object.entries(template.findResources('AWS::IAM::Policy')).find(([id]) =>
        id.startsWith('DocWorkerFnServiceRoleDefaultPolicy'),
      )?.[1] as { Properties: { PolicyDocument: { Statement: unknown[] } } }
    ).Properties.PolicyDocument.Statement;

    const text = JSON.stringify(statements);
    expect(text).toContain('s3:GetObject');
    expect(text).toContain('s3:PutObject');

    // The write must be scoped to the documents bucket. Evidence is
    // append-only by bucket policy, and nothing in this stack should be
    // asking to put an object there.
    const puts = (statements as Array<{ Action?: string | string[]; Resource?: unknown }>).filter(
      (st) => (Array.isArray(st.Action) ? st.Action : [st.Action]).includes('s3:PutObject'),
    );
    // The buckets are imported by name, so their ARNs carry the name rather
    // than a logical-id reference — the assertion matches what is actually in
    // the template.
    expect(puts.length).toBeGreaterThan(0);
    for (const put of puts) {
      expect(JSON.stringify(put.Resource)).toContain('test-documents');
      expect(JSON.stringify(put.Resource)).not.toContain('test-evidence');
    }
  });

  /**
   * Delivery is cut from this build (CLAUDE.md "Scope"), so the worker holds
   * no send permission. An unused SES grant on a function that handles a
   * tenant's address and photographs is precisely what later becomes an
   * accidental send path.
   */
  it('holds no SES permission anywhere in the stack', () => {
    expect(JSON.stringify(template.findResources('AWS::IAM::Policy'))).not.toContain('ses:');
  });

  it('is invoked by complete-phase and by diff-worker, and by nothing else', () => {
    const invokers = Object.entries(template.findResources('AWS::IAM::Policy'))
      .filter(([, policy]) => JSON.stringify(policy).includes('lambda:InvokeFunction'))
      .map(([id]) => id);

    expect(invokers).toHaveLength(2);
    expect(invokers.some((id) => id.startsWith('CompletePhaseFn'))).toBe(true);
    expect(invokers.some((id) => id.startsWith('DiffWorkerFn'))).toBe(true);
  });

  it('tells both dispatchers which function to invoke', () => {
    const envOf = (prefix: string): Record<string, unknown> | undefined =>
      (
        Object.entries(template.findResources('AWS::Lambda::Function')).find(([id]) =>
          id.startsWith(prefix),
        )?.[1] as { Properties: { Environment?: { Variables?: Record<string, unknown> } } }
      ).Properties.Environment?.Variables;

    expect(envOf('CompletePhaseFn')).toHaveProperty('DOC_WORKER_FUNCTION_NAME');
    expect(envOf('DiffWorkerFn')).toHaveProperty('DOC_WORKER_FUNCTION_NAME');
  });

  it('is not exposed as an HTTP route', () => {
    expect(routes().some((r) => r.Properties.RouteKey.toLowerCase().includes('doc'))).toBe(false);
  });
});

describe('CORS (§5.1)', () => {
  it('allows the methods the frontend actually issues', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowMethods: Match.arrayWith(['GET', 'POST', 'PATCH']),
      }),
    });
  });
});
