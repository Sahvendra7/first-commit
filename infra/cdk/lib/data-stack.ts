/**
 * `data-stack` — architecture.md §5.8, §6.1, §6.2, §6.4, §10.1, §10.3.
 *
 * The DynamoDB single table and both S3 buckets. This is the stack that holds
 * the product's claim to be evidence rather than a photo album (§15.4), so the
 * settings below are the ones the `aws-cdk-handover` skill marks as never cut:
 * versioning on, delete denied in the bucket policy, PITR on.
 *
 * Every construct property here was checked against the AWS documentation and
 * the installed `aws-cdk-lib` typings rather than written from memory — the
 * PITR property in particular, where the obvious `pointInTimeRecovery` boolean
 * is deprecated in favour of `pointInTimeRecoverySpecification`.
 */
import {
  Aws,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
} from 'aws-cdk-lib';
import {
  AttributeType,
  BillingMode,
  ProjectionType,
  Table,
  TableEncryption,
} from 'aws-cdk-lib/aws-dynamodb';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  ObjectOwnership,
  StorageClass,
} from 'aws-cdk-lib/aws-s3';
import { AnyPrincipal, Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

/** GSI names, spelled once. The application reads them from `@handover/shared`. */
export const GSI1_NAME = 'GSI1';
export const GSI2_NAME = 'GSI2';

export class DataStack extends Stack {
  readonly table: Table;
  readonly evidenceBucket: Bucket;
  readonly documentsBucket: Bucket;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    /* ── DynamoDB: one table, two indexes (§6.1, §6.2) ────────────────────── */

    this.table = new Table(this, 'HandoverTable', {
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },

      // §6.1: "On-demand billing means idle cost is zero."
      billingMode: BillingMode.PAY_PER_REQUEST,

      // Non-negotiable. §6.1 calls PITR "a checkbox"; it is the only thing
      // standing between a bad conditional write and unrecoverable evidence.
      // `pointInTimeRecovery` (boolean) is deprecated in aws-cdk-lib 2.270 —
      // the specification object is the current property.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },

      // §10.3: DynamoDB encryption at rest, AWS-managed keys at MVP. A
      // customer-managed KMS key waits for a compliance requirement that
      // justifies the key-management overhead.
      encryption: TableEncryption.AWS_MANAGED,

      // §6.4: jobs expire after 7 days, diff-cache entries after 90. Both write
      // an epoch-seconds `ttl`; DynamoDB needs one attribute name for both.
      timeToLiveAttribute: 'ttl',

      // The table holds the evidence ledger. A stack delete must never take it.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // AP-4: a user's tenancies, newest last.
    this.table.addGlobalSecondaryIndex({
      indexName: GSI1_NAME,
      partitionKey: { name: 'GSI1PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    /**
     * AP-5: the sparse clock index.
     *
     * Sparseness is a property of the *writer*, not of this declaration:
     * `GSI2PK` is written only while a tenancy is `AWAITING_REFUND` and removed
     * when it leaves, so the index contains only tenancies actually at risk and
     * the daily sweep stays O(pending) rather than O(all data) (§6.2).
     *
     * `KEYS_ONLY` rather than `ALL`: the sweeper queries this index to find
     * which tenancies are due, then reads each one from the base table. There
     * is no point paying to project every attribute of every pending tenancy
     * into an index whose entire job is to produce a list of ids.
     */
    this.table.addGlobalSecondaryIndex({
      indexName: GSI2_NAME,
      partitionKey: { name: 'GSI2PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });

    /* ── S3: evidence (§5.8, §10.1) ───────────────────────────────────────── */

    this.evidenceBucket = new Bucket(this, 'EvidenceBucket', {
      // Globally unique without putting an account id in a committed file
      // (§10.3): the token resolves at synth time from the deploy environment.
      bucketName: `handover-evidence-${Aws.ACCOUNT_ID}-${Aws.REGION}`,

      // The single most important line in this stack. Without versioning, a
      // delete is a delete and the ledger has no history to be evident of.
      versioned: true,

      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN,

      // §6.4 lifecycle. Note there is no expiration rule of any kind: evidence
      // transitions to colder storage and never leaves.
      lifecycleRules: [
        {
          id: 'evidence-cooling',
          enabled: true,
          transitions: [
            { storageClass: StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(90) },
            {
              storageClass: StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: Duration.days(730),
            },
          ],
          // Old versions cool too, but are likewise never expired.
          noncurrentVersionTransitions: [
            {
              storageClass: StorageClass.INFREQUENT_ACCESS,
              transitionAfter: Duration.days(90),
            },
          ],
        },
      ],
    });

    /**
     * Deny deletion and tampering to **every** principal (§10.1 "Evidence
     * tampering").
     *
     * All four actions are required, and the third and fourth are the ones that
     * are easy to miss:
     *
     *  - `s3:DeleteObject` removes the current version (writes a delete marker).
     *  - `s3:DeleteObjectVersion` removes a specific version permanently.
     *  - `s3:PutBucketVersioning` could *suspend* versioning, after which a
     *    plain delete is permanent again.
     *  - `s3:PutLifecycleConfiguration` could add an expiration rule and let S3
     *    delete the objects on our behalf — the AWS documentation names this as
     *    a required part of any "prevent deletion" policy, because lifecycle
     *    expiry is not itself a `DeleteObject` call by any principal.
     *
     * **Operational consequence, deliberately accepted:** because lifecycle
     * configuration is denied, changing the rules above on an already-deployed
     * bucket requires removing this statement, deploying, changing the rules,
     * deploying, and putting the statement back. That is friction on a rare
     * operation, traded for closing the only path by which these objects can be
     * deleted without anyone calling delete.
     *
     * This is a guard against accident and against a compromised application
     * role, not against a determined account administrator — anyone who can
     * rewrite the bucket policy can lift the deny. That is inherent to
     * resource-based policies, and it is why §15.4 pairs this with versioning
     * and hashing rather than relying on it alone.
     */
    this.evidenceBucket.addToResourcePolicy(
      new PolicyStatement({
        sid: 'DenyEvidenceDestruction',
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: [
          's3:DeleteObject',
          's3:DeleteObjectVersion',
          's3:PutBucketVersioning',
          's3:PutLifecycleConfiguration',
        ],
        resources: [this.evidenceBucket.bucketArn, this.evidenceBucket.arnForObjects('*')],
      }),
    );

    /* ── S3: generated documents (§5.8) ───────────────────────────────────── */

    /**
     * Versioned too, but *not* delete-denied. A regenerated Condition Report is
     * a new version of a derived artifact, and unlike evidence it can be
     * rebuilt from the ledger at any time. Reachable only through a presigned
     * GET of at most 5 minutes (§7).
     */
    this.documentsBucket = new Bucket(this, 'DocumentsBucket', {
      bucketName: `handover-documents-${Aws.ACCOUNT_ID}-${Aws.REGION}`,
      versioned: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    Tags.of(this).add('handover:stack', 'data');

    new CfnOutput(this, 'TableName', { value: this.table.tableName });
    new CfnOutput(this, 'EvidenceBucketName', { value: this.evidenceBucket.bucketName });
    new CfnOutput(this, 'DocumentsBucketName', { value: this.documentsBucket.bucketName });
  }
}
