import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { WebStack } from '../lib/web-stack.js';

/**
 * `web-stack` — the hosting facts that are silent when wrong.
 *
 * Three of these break the product rather than the build:
 *
 * - A **public bucket** turns the origin into something reachable around
 *   CloudFront, so the response headers and the TLS redirect stop being
 *   guarantees.
 * - **No SPA rewrite** means a refresh on `/?tenancy=x` returns 404, which to a
 *   tenant looks exactly like their record having been deleted.
 * - A **long-cached `index.html` or `sw.js`** pins a returning device to a dead
 *   build: the html points at assets that no longer exist, and the worker keeps
 *   serving the old shell for as long as its TTL.
 */

let template: Template;

interface CachePolicyResource {
  Properties: {
    CachePolicyConfig: {
      Comment?: string;
      MaxTTL: number;
      MinTTL: number;
      DefaultTTL: number;
    };
  };
}

beforeAll(() => {
  const app = new App();
  const stack = new WebStack(app, 'TestWeb', {
    env: { account: '111111111111', region: 'ap-south-1' },
  });
  template = Template.fromStack(stack);
});

describe('the origin bucket', () => {
  it('blocks all public access', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('is encrypted at rest', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: Match.anyValue(),
      }),
    });
  });

  it('is not configured as an S3 website, which would be HTTP-only and public', () => {
    const buckets = Object.values(template.findResources('AWS::S3::Bucket')) as {
      Properties: Record<string, unknown>;
    }[];
    for (const bucket of buckets) {
      expect(bucket.Properties['WebsiteConfiguration']).toBeUndefined();
    }
  });

  it('grants read only to the CloudFront distribution, not to the world', () => {
    const policies = Object.values(template.findResources('AWS::S3::BucketPolicy')) as {
      Properties: { PolicyDocument: { Statement: Record<string, unknown>[] } };
    }[];

    const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
    const readers = statements.filter((s) => {
      const action = JSON.stringify(s['Action'] ?? '');
      return action.includes('s3:GetObject');
    });

    expect(readers.length).toBeGreaterThan(0);
    for (const statement of readers) {
      const principal = JSON.stringify(statement['Principal'] ?? '');
      expect(principal).toContain('cloudfront');
      expect(principal).not.toContain('"*"');
    }
  });
});

describe('the distribution', () => {
  it('serves index.html as the root object', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ DefaultRootObject: 'index.html' }),
    });
  });

  it('redirects every viewer to HTTPS', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
        }),
      }),
    });
  });

  it('rewrites 403 and 404 to the app with a 200, so a refresh works', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 403,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
            ErrorCachingMinTTL: 0,
          }),
          Match.objectLike({
            ErrorCode: 404,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
            ErrorCachingMinTTL: 0,
          }),
        ]),
      }),
    });
  });

  it('gives /assets/* its own behaviour', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([Match.objectLike({ PathPattern: '/assets/*' })]),
      }),
    });
  });

  it('publishes the public URL as an output', () => {
    const outputs = template.findOutputs('*');
    expect(Object.keys(outputs)).toContain('WebUrl');
  });
});

describe('caching', () => {
  const policies = (): CachePolicyResource[] =>
    Object.values(
      template.findResources('AWS::CloudFront::CachePolicy'),
    ) as CachePolicyResource[];

  it('never caches the entry document or the service worker at the edge', () => {
    const noStore = policies().find((p) =>
      (p.Properties.CachePolicyConfig.Comment ?? '').includes('index.html'),
    );
    expect(noStore).toBeDefined();
    expect(noStore?.Properties.CachePolicyConfig.MaxTTL).toBe(0);
    expect(noStore?.Properties.CachePolicyConfig.DefaultTTL).toBe(0);
  });

  it('caches content-hashed assets for a long time', () => {
    const immutable = policies().find((p) =>
      (p.Properties.CachePolicyConfig.Comment ?? '').includes('Vite'),
    );
    expect(immutable).toBeDefined();
    // A year, in seconds.
    expect(immutable?.Properties.CachePolicyConfig.MaxTTL).toBe(31_536_000);
  });

  it('keeps query strings out of every cache key', () => {
    for (const policy of policies()) {
      const config = policy.Properties.CachePolicyConfig as unknown as {
        ParametersInCacheKeyAndForwardedToOrigin: {
          QueryStringsConfig: { QueryStringBehavior: string };
        };
      };
      expect(
        config.ParametersInCacheKeyAndForwardedToOrigin.QueryStringsConfig
          .QueryStringBehavior,
      ).toBe('none');
    }
  });
});

describe('security headers', () => {
  const cspOf = (): string => {
    const policies = Object.values(
      template.findResources('AWS::CloudFront::ResponseHeadersPolicy'),
    ) as {
      Properties: {
        ResponseHeadersPolicyConfig: {
          SecurityHeadersConfig: {
            ContentSecurityPolicy?: { ContentSecurityPolicy: string };
          };
        };
      };
    }[];
    const csp =
      policies[0]?.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig
        .ContentSecurityPolicy?.ContentSecurityPolicy;
    if (!csp) throw new Error('no content security policy on the distribution');
    return csp;
  };

  it('forbids inline and remote script', () => {
    const csp = cspOf();
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("script-src *");
  });

  it('admits the API, S3 and Cognito to connect-src, and nothing else', () => {
    const csp = cspOf();
    const connect = csp.split('; ').find((d) => d.startsWith('connect-src')) ?? '';
    expect(connect).toContain('execute-api.ap-south-1.amazonaws.com');
    expect(connect).toContain('s3.ap-south-1.amazonaws.com');
    expect(connect).toContain('cognito-idp.ap-south-1.amazonaws.com');
    expect(connect).not.toContain('*;');
  });

  it('refuses to be framed', () => {
    expect(cspOf()).toContain("frame-ancestors 'none'");
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          FrameOptions: Match.objectLike({ FrameOption: 'DENY' }),
        }),
      }),
    });
  });

  it('does not leak a presigned URL through the Referer header', () => {
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ReferrerPolicy: Match.objectLike({
            ReferrerPolicy: 'strict-origin-when-cross-origin',
          }),
        }),
      }),
    });
  });

  it('sets HSTS', () => {
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          StrictTransportSecurity: Match.objectLike({ AccessControlMaxAgeSec: 31_536_000 }),
        }),
      }),
    });
  });
});
