import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { DataStack } from '../lib/data-stack.js';

/**
 * `data-stack` — the settings the `aws-cdk-handover` skill marks "non-negotiable
 * — cut anything else first", asserted against the synthesised template.
 *
 * These are not style checks. §15.4 says versioning, deny-delete and PITR are
 * "the entire basis of the product's claim to be evidence rather than a photo
 * album". A regression in any of them would be invisible in the UI, invisible
 * in the tests of every other layer, and fatal to the only thing the product
 * claims. So they are asserted here, in the template, where a future edit that
 * silently drops one fails the build.
 */

let template: Template;

/**
 * Buckets are selected by logical id, not by name. `bucketName` is built from
 * `Aws.ACCOUNT_ID`, so in the synthesised template it is an `Fn::Join` token
 * rather than a string — which is exactly the property the last test in this
 * file asserts, and the reason a name-matcher cannot be used to tell the two
 * buckets apart.
 */
interface LifecycleRule {
  Transitions?: { StorageClass: string; TransitionInDays: number }[];
  ExpirationInDays?: number;
  ExpirationDate?: string;
  NoncurrentVersionExpiration?: unknown;
}

interface SynthesisedBucket {
  Properties: {
    VersioningConfiguration?: { Status: string };
    PublicAccessBlockConfiguration?: Record<string, boolean>;
    BucketEncryption?: unknown;
    LifecycleConfiguration?: { Rules: LifecycleRule[] };
  };
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
}

const bucketByLogicalId = (prefix: string): SynthesisedBucket => {
  const buckets = template.findResources('AWS::S3::Bucket');
  const entry = Object.entries(buckets).find(([id]) => id.startsWith(prefix));
  if (!entry) throw new Error(`No bucket with logical id starting "${prefix}"`);
  return entry[1] as SynthesisedBucket;
};

beforeAll(() => {
  const app = new App();
  const stack = new DataStack(app, 'TestData', {
    env: { account: '123456789012', region: 'ap-south-1' },
  });
  template = Template.fromStack(stack);
});

describe('DynamoDB — the single table (§6.1, §6.2)', () => {
  it('creates exactly one table', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
  });

  it('has point-in-time recovery ON', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });

  it('bills on demand, so idle cost is zero', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('is keyed PK/SK as the §6.2 access-pattern table requires', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
    });
  });

  it('enables TTL on the shared `ttl` attribute (jobs 7d, diff cache 90d)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    });
  });

  it('is encrypted at rest', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      SSESpecification: { SSEEnabled: true },
    });
  });

  it('carries both secondary indexes', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
        }),
        Match.objectLike({
          IndexName: 'GSI2',
          KeySchema: [
            { AttributeName: 'GSI2PK', KeyType: 'HASH' },
            { AttributeName: 'GSI2SK', KeyType: 'RANGE' },
          ],
        }),
      ]),
    });
  });

  /**
   * GSI2 exists to answer "which tenancies are past their deadline" — a list of
   * ids. Projecting every attribute would pay storage and write cost for data
   * the sweeper re-reads from the base table anyway.
   */
  it('projects GSI2 as KEYS_ONLY', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'GSI2', Projection: { ProjectionType: 'KEYS_ONLY' } }),
      ]),
    });
  });

  it('is retained when the stack is deleted', () => {
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });
});

describe('S3 evidence bucket — the non-negotiables (§10.1, §15.4)', () => {
  it('has versioning ON', () => {
    expect(bucketByLogicalId('EvidenceBucket').Properties.VersioningConfiguration).toEqual({
      Status: 'Enabled',
    });
  });

  it('blocks all public access', () => {
    expect(
      bucketByLogicalId('EvidenceBucket').Properties.PublicAccessBlockConfiguration,
    ).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
  });

  it('is encrypted with SSE-S3', () => {
    expect(bucketByLogicalId('EvidenceBucket').Properties.BucketEncryption).toEqual({
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
      ],
    });
  });

  it('is retained when the stack is deleted', () => {
    const buckets = template.findResources('AWS::S3::Bucket');
    for (const bucket of Object.values(buckets)) {
      expect(bucket.DeletionPolicy).toBe('Retain');
      expect(bucket.UpdateReplacePolicy).toBe('Retain');
    }
  });

  it('cools to Standard-IA at 90 days and Glacier IR at 2 years', () => {
    const rules = bucketByLogicalId('EvidenceBucket').Properties.LifecycleConfiguration?.Rules ?? [];
    const transitions = rules.flatMap((r) => r.Transitions ?? []);
    expect(transitions).toContainEqual({ StorageClass: 'STANDARD_IA', TransitionInDays: 90 });
    expect(transitions).toContainEqual({ StorageClass: 'GLACIER_IR', TransitionInDays: 730 });
  });

  /** Evidence cools forever; it never expires. */
  it('has no expiration rule of any kind', () => {
    const buckets = template.findResources('AWS::S3::Bucket');
    for (const bucket of Object.values(buckets)) {
      const rules = bucket.Properties?.LifecycleConfiguration?.Rules ?? [];
      for (const rule of rules) {
        expect(rule.ExpirationInDays).toBeUndefined();
        expect(rule.ExpirationDate).toBeUndefined();
        expect(rule.NoncurrentVersionExpiration).toBeUndefined();
      }
    }
  });
});

describe('the deny-delete bucket policy (§10.1 "Evidence tampering")', () => {
  const denyStatement = (): Record<string, unknown> => {
    const policies = template.findResources('AWS::S3::BucketPolicy');
    for (const policy of Object.values(policies)) {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      const deny = statements.find(
        (s: Record<string, unknown>) => s['Sid'] === 'DenyEvidenceDestruction',
      );
      if (deny) return deny;
    }
    throw new Error('No DenyEvidenceDestruction statement found');
  };

  it('exists on the evidence bucket', () => {
    expect(denyStatement()).toBeDefined();
  });

  it('is an explicit Deny against every principal', () => {
    const deny = denyStatement();
    expect(deny['Effect']).toBe('Deny');
    expect(deny['Principal']).toEqual({ AWS: '*' });
  });

  it('denies s3:DeleteObjectVersion — the permanent delete', () => {
    expect(denyStatement()['Action']).toContain('s3:DeleteObjectVersion');
  });

  it('denies s3:DeleteObject — the delete marker', () => {
    expect(denyStatement()['Action']).toContain('s3:DeleteObject');
  });

  /**
   * Without this, versioning could be suspended and a plain delete would be
   * permanent again — the deny above would still be in force and still useless.
   */
  it('denies s3:PutBucketVersioning, so versioning cannot be suspended', () => {
    expect(denyStatement()['Action']).toContain('s3:PutBucketVersioning');
  });

  /**
   * The AWS documentation names this as a required part of any policy that
   * intends to prevent deletion: lifecycle expiry deletes objects without any
   * principal calling DeleteObject, so denying the delete APIs alone leaves the
   * path open.
   */
  it('denies s3:PutLifecycleConfiguration, closing the lifecycle-expiry path', () => {
    expect(denyStatement()['Action']).toContain('s3:PutLifecycleConfiguration');
  });

  it('covers both the bucket and its objects', () => {
    const resources = denyStatement()['Resource'];
    expect(Array.isArray(resources)).toBe(true);
    expect((resources as unknown[]).length).toBe(2);
  });
});

describe('S3 documents bucket (§5.8)', () => {
  it('is versioned and private', () => {
    const docs = bucketByLogicalId('DocumentsBucket').Properties;
    expect(docs.VersioningConfiguration).toEqual({ Status: 'Enabled' });
    expect(docs.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
  });

  it('creates exactly two buckets and no more', () => {
    template.resourceCountIs('AWS::S3::Bucket', 2);
  });

  /**
   * Documents are derived artifacts and can be regenerated from the ledger, so
   * they are versioned but not delete-denied. Only evidence carries the deny.
   */
  it('is not covered by the evidence deny statement', () => {
    const policies = template.findResources('AWS::S3::BucketPolicy');
    const denyPolicies = Object.values(policies).filter((p) =>
      (p.Properties?.PolicyDocument?.Statement ?? []).some(
        (s: Record<string, unknown>) => s['Sid'] === 'DenyEvidenceDestruction',
      ),
    );
    expect(denyPolicies).toHaveLength(1);
  });
});

describe('no account id is hardcoded (§10.3)', () => {
  /**
   * Bucket names must be globally unique, which usually tempts an account id
   * into a committed file. `Aws.ACCOUNT_ID` resolves at synth time from the
   * deploy environment instead, so the *source* carries no account number even
   * though the synthesised template does.
   */
  it('builds bucket names from the account token rather than a literal', () => {
    const source = readStackSource();
    expect(source).toContain('Aws.ACCOUNT_ID');
    expect(source).not.toMatch(/\b\d{12}\b/);
  });
});

function readStackSource(): string {
  return readFileSync(join(import.meta.dirname, '../lib/data-stack.ts'), 'utf8');
}
