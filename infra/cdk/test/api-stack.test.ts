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
  const app = new App();
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

describe('least privilege (§10.3)', () => {
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

describe('CORS (§5.1)', () => {
  it('allows the methods the frontend actually issues', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowMethods: Match.arrayWith(['GET', 'POST', 'PATCH']),
      }),
    });
  });
});
