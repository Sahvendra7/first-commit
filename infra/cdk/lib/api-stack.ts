/**
 * `api-stack` — architecture.md §5.2, §5.3, §5.4, §10.3.
 *
 * The HTTP API, its Cognito JWT authorizer, and the Lambdas of the capture
 * path. The five functions are **deployment units, not service boundaries**
 * (§3.2): they share one bundled codebase and one table, and they version and
 * deploy together. What differs between them is their IAM role, and that is the
 * point — §10.3's least-privilege table is reproduced in the grants below.
 *
 * Only the capture-path functions are wired here. `diff-worker`, `doc-worker`
 * and `clock-sweeper` join this same stack when their paths are built.
 */
import { CfnOutput, Duration, Stack, Tags } from 'aws-cdk-lib';
import { HttpApi, HttpMethod, CorsHttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Bucket, EventType } from 'aws-cdk-lib/aws-s3';
import { LambdaDestination } from 'aws-cdk-lib/aws-s3-notifications';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { join } from 'node:path';
import type { StackProps } from 'aws-cdk-lib';
import type { IUserPool, IUserPoolClient } from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';

/**
 * Resources are passed by **name**, not as construct references.
 *
 * That is not a style preference. `Bucket.addEventNotification` mutates the
 * bucket's own stack, so wiring `photo-ingest` to a `Bucket` object owned by
 * `data-stack` makes data-stack depend on api-stack for the function ARN while
 * api-stack already depends on data-stack for the bucket — a dependency cycle
 * CDK refuses to synthesise. Importing by name gives api-stack its own handle,
 * so the notification and its custom resource land here and the dependency
 * points one way only.
 */
export interface ApiStackProps extends StackProps {
  readonly tableName: string;
  readonly evidenceBucketName: string;
  readonly documentsBucketName: string;
  readonly userPool: IUserPool;
  readonly userPoolClient: IUserPoolClient;
}

/** Where the handler sources live, relative to this file at synth time. */
const SRC = join(import.meta.dirname, '../../../apps/api/src');

export class ApiStack extends Stack {
  readonly httpApi: HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { userPool, userPoolClient } = props;

    const table = Table.fromTableName(this, 'HandoverTable', props.tableName);
    const evidenceBucket = Bucket.fromBucketName(this, 'EvidenceBucket', props.evidenceBucketName);
    const documentsBucket = Bucket.fromBucketName(
      this,
      'DocumentsBucket',
      props.documentsBucketName,
    );

    /**
     * Defaults every function shares (§5.3, the skill's "Function defaults").
     * ARM64 is not a micro-optimisation here: it is cheaper per millisecond and
     * this workload is entirely I/O-bound glue.
     */
    const defaults = {
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(30),
      bundling: {
        format: OutputFormat.ESM,
        target: 'node20',
        minify: false,
        sourceMap: true,
      },
      environment: {
        TABLE_NAME: table.tableName,
        EVIDENCE_BUCKET: evidenceBucket.bucketName,
        DOCUMENTS_BUCKET: documentsBucket.bucketName,
        NODE_OPTIONS: '--enable-source-maps',
      },
    };

    const fn = (name: string, entry: string, over: Record<string, unknown> = {}): NodejsFunction => {
      const f = new NodejsFunction(this, name, {
        ...defaults,
        entry: join(SRC, entry),
        handler: 'handler',
        ...over,
      });
      new LogGroup(this, `${name}Logs`, {
        logGroupName: `/aws/lambda/${f.functionName}`,
        retention: RetentionDays.TWO_WEEKS,
      });
      return f;
    };

    /* ── api-handler (§5.3) ───────────────────────────────────────────────── */

    const createTenancy = fn('CreateTenancyFn', 'handlers/http/create-tenancy.ts');
    const presignPhotos = fn('PresignPhotosFn', 'handlers/http/presign-photos.ts');
    const completePhase = fn('CompletePhaseFn', 'handlers/http/complete-phase.ts', {
      // The bounded ingest wait is up to 10s (§6.4); the timeout must clear it
      // with room for the surrounding reads.
      timeout: Duration.seconds(30),
    });
    const getTenancy = fn('GetTenancyFn', 'handlers/http/get-tenancy.ts');
    const getDiff = fn('GetDiffFn', 'handlers/http/get-diff.ts');

    const apiHandlers = [createTenancy, presignPhotos, completePhase, getTenancy, getDiff];

    for (const handler of apiHandlers) {
      table.grantReadWriteData(handler);
    }

    /**
     * §10.3, exactly: `api-handler` gets `s3:PutObject` on the upload prefix —
     * which is what a presigned POST delegates — but **not** `s3:GetObject`.
     *
     * It still issues presigned *GET* URLs. Signing is a local computation over
     * the caller's credentials; the resulting URL only works if those
     * credentials could perform the GET. That is a real and deliberate gap:
     * these functions can mint download URLs but cannot themselves read an
     * object, so a compromised api-handler cannot exfiltrate the evidence
     * bucket by iterating it. Closing the gap the other way — granting
     * GetObject — is what §10.3 forbids.
     */
    const presignGrant = new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['s3:PutObject'],
      resources: [evidenceBucket.arnForObjects('tenancies/*')],
    });
    for (const handler of [presignPhotos]) {
      handler.addToRolePolicy(presignGrant);
    }

    // The read paths sign GET URLs for objects under the same prefix.
    const signGetGrant = new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: [evidenceBucket.arnForObjects('tenancies/*')],
    });
    for (const handler of [getTenancy, getDiff]) {
      handler.addToRolePolicy(signGetGrant);
    }

    /* ── photo-ingest (§5.4) ──────────────────────────────────────────────── */

    /**
     * Its own function because it runs on an S3 event rather than an HTTP
     * request, has different IAM needs, and must be independently retryable
     * (§5.4). S3 event delivery plus Lambda's built-in retry gives durable
     * at-least-once ingestion with no broker.
     *
     * Memory is higher than the API defaults because it streams and hashes up
     * to 8 MB; the timeout is generous for the same reason.
     */
    const photoIngest = fn('PhotoIngestFn', 'handlers/events/photo-ingest.ts', {
      memorySize: 1024,
      timeout: Duration.seconds(60),
    });

    // §10.3: `s3:GetObject` on evidence, DynamoDB write. No presign, no
    // Bedrock, no SES.
    evidenceBucket.grantRead(photoIngest, 'tenancies/*');
    table.grantReadWriteData(photoIngest);

    evidenceBucket.addEventNotification(
      EventType.OBJECT_CREATED,
      new LambdaDestination(photoIngest),
      { prefix: 'tenancies/' },
    );

    /* ── HTTP API (§5.2) ──────────────────────────────────────────────────── */

    const authorizer = new HttpJwtAuthorizer(
      'CognitoJwt',
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      {
        identitySource: ['$request.header.Authorization'],
        jwtAudience: [userPoolClient.userPoolClientId],
      },
    );

    this.httpApi = new HttpApi(this, 'HandoverApi', {
      corsPreflight: {
        allowHeaders: ['Authorization', 'Content-Type'],
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.PATCH,
          CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: ['http://localhost:5173'],
        maxAge: Duration.hours(1),
      },
      defaultAuthorizer: authorizer,
    });

    const route = (path: string, method: HttpMethod, handler: NodejsFunction, name: string): void => {
      this.httpApi.addRoutes({
        path,
        methods: [method],
        integration: new HttpLambdaIntegration(`${name}Integration`, handler),
      });
    };

    route('/v1/tenancies', HttpMethod.POST, createTenancy, 'CreateTenancy');
    route('/v1/tenancies/{id}', HttpMethod.GET, getTenancy, 'GetTenancy');
    route('/v1/tenancies/{id}/photos:presign', HttpMethod.POST, presignPhotos, 'PresignPhotos');
    route(
      '/v1/tenancies/{id}/phases/{phase}/complete',
      HttpMethod.POST,
      completePhase,
      'CompletePhase',
    );
    route('/v1/tenancies/{id}/diff', HttpMethod.GET, getDiff, 'GetDiff');

    Tags.of(this).add('handover:stack', 'api');

    new CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, 'PhotoIngestFunctionName', { value: photoIngest.functionName });
  }
}
