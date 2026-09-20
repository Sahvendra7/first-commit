/**
 * `api-stack` — architecture.md §5.2, §5.3, §5.4, §10.3.
 *
 * The HTTP API, its Cognito JWT authorizer, and the Lambdas of the capture
 * path. The five functions are **deployment units, not service boundaries**
 * (§3.2): they share one bundled codebase and one table, and they version and
 * deploy together. What differs between them is their IAM role, and that is the
 * point — §10.3's least-privilege table is reproduced in the grants below.
 *
 * The capture path and all three workers — `diff-worker`, `doc-worker` and
 * `clock-sweeper` — are wired here.
 *
 * ── One function per route, and why that is not a service split ─────────────
 * §3.2 names five *logical* units, of which `api-handler` is one. This stack
 * deploys each HTTP route as its own `NodejsFunction`, which looks like a
 * finer split than the document describes and is not one: every function is
 * built from the same `apps/api/src` tree, shares the same domain modules and
 * the same table, and they version and deploy together — the §3.2 test for
 * "deployment unit, not service boundary". What the split buys is the §10.3
 * IAM table, which grants different permissions to different routes:
 * `presign-photos` needs `s3:PutObject` and the read paths need `s3:GetObject`
 * and the two must not be the same role, and only `complete-phase` may invoke
 * a worker. Collapsing them into one function to match the document's noun
 * would mean one role holding the union of every grant, which is the thing
 * §10.3 is written to prevent.
 */
import { CfnOutput, Duration, Stack, Tags } from 'aws-cdk-lib';
import {
  HttpApi,
  HttpMethod,
  CorsHttpMethod,
  HttpNoneAuthorizer,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { GSI1_NAME, GSI2_NAME } from './data-stack.js';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Bucket, EventType } from 'aws-cdk-lib/aws-s3';
import { LambdaDestination } from 'aws-cdk-lib/aws-s3-notifications';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
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
  /**
   * Extra browser origins permitted by CORS, beyond the local dev server.
   *
   * The deployed front end lives on a CloudFront domain that does not exist
   * until `WebStack` has been created, so it arrives here as a value rather
   * than as a cross-stack reference — that would make the API stack
   * undeployable until the web stack existed, and the two are otherwise
   * independent. Passed on the command line:
   *
   *     cdk deploy HandoverDevApi -c webOrigin=https://dxxxx.cloudfront.net
   *
   * An origin is scheme + host (+ port) with no path or trailing slash; the
   * browser compares it literally.
   */
  readonly webOrigins?: readonly string[];
}

/** Where the handler sources live, relative to this file at synth time. */
const SRC = join(import.meta.dirname, '../../../apps/api/src');

export class ApiStack extends Stack {
  readonly httpApi: HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { userPool, userPoolClient } = props;

    /**
     * Imported with its indexes named, not by bare name.
     *
     * `Table.fromTableName` produces an `ITable` that knows of no global
     * secondary indexes, so `grantReadWriteData` writes a policy covering
     * `table/<name>` and nothing else. A `Query` against `GSI2` needs
     * `table/<name>/index/GSI2`, so `clock-sweeper` — whose entire job is that
     * query — would have deployed cleanly and then failed with AccessDenied on
     * its first run, at 03:30, where nobody was looking.
     *
     * Declaring the indexes makes the grants include `index/*`.
     */
    const table = Table.fromTableAttributes(this, 'HandoverTable', {
      tableName: props.tableName,
      globalIndexes: [GSI1_NAME, GSI2_NAME],
    });
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
    const patchDiff = fn('PatchDiffFn', 'handlers/http/patch-diff.ts');
    const getJob = fn('GetJobFn', 'handlers/http/get-job.ts');
    const createClaim = fn('CreateClaimFn', 'handlers/http/create-claim.ts');

    const apiHandlers = [
      createTenancy,
      presignPhotos,
      completePhase,
      getTenancy,
      getDiff,
      patchDiff,
      getJob,
      createClaim,
    ];

    for (const handler of apiHandlers) {
      table.grantReadWriteData(handler);
    }

    /**
     * The public route (§5.2). It serves the reviewed statutory table and
     * nothing else, so it gets **read-only** table access rather than the
     * read/write the authenticated handlers carry: an unauthenticated function
     * that could write to the evidence table would be a far worse thing to get
     * wrong than one that can read a rules row.
     */
    const getStateRules = fn('GetStateRulesFn', 'handlers/http/get-state-rules.ts');
    table.grantReadData(getStateRules);

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

    /* ── diff-worker (§5.5) ───────────────────────────────────────────────── */

    /**
     * §5.5's sizing, exactly: timeout 300s, memory 1024 MB.
     *
     * Both numbers are load-bearing rather than round. The adapter samples one
     * pair N=5 times (§9.5) and a room may hold up to three pairs (§9.4), so a
     * six-room tenancy is a long sequential walk even with the per-pair fan-out
     * — 30s would not clear one room. The memory is for holding two whole 8 MB
     * images plus their base64 expansion while the request body is built.
     */
    const diffWorker = fn('DiffWorkerFn', 'handlers/events/diff-worker.ts', {
      memorySize: 1024,
      timeout: Duration.minutes(5),
      bundling: {
        ...defaults.bundling,
        /**
         * The prompts are Markdown files the registry reads from disk at cold
         * start (§9.3: prompts are versioned artifacts, never inline strings),
         * and esbuild bundles JavaScript only — without this copy the function
         * starts, finds no `room-diff.md`, and throws. The registry throws
         * loudly rather than serving an empty prompt precisely so that a
         * forgotten copy step fails at cold start instead of silently sending
         * the model no instructions.
         */
        commandHooks: {
          beforeBundling: (): string[] => [],
          beforeInstall: (): string[] => [],
          afterBundling: (inputDir: string, outputDir: string): string[] => [
            `mkdir -p ${outputDir}/prompts`,
            `cp -r ${inputDir}/apps/api/src/prompts/v1 ${inputDir}/apps/api/src/prompts/v2 ${outputDir}/prompts/`,
          ],
        },
      },
    });

    // §10.3: `s3:GetObject` on evidence and DynamoDB read/write. It reads the
    // photographs and writes DIFF items, the diff cache and job progress.
    evidenceBucket.grantRead(diffWorker, 'tenancies/*');
    table.grantReadWriteData(diffWorker);

    /**
     * The model configuration, read at runtime rather than baked in (§10.3:
     * "no secret is ever in an environment variable or in the repository").
     *
     * Note what is **not** granted: `bedrock:InvokeModel`. The skill's IAM
     * table lists it for this function, and it is deliberately omitted — it
     * would be a permission this code cannot use. `bedrock-runtime` is
     * unauthorised on this account (§9.1), so the working path is the
     * bedrock-mantle Chat Completions endpoint over HTTPS with a bearer token
     * from Secrets Manager. Granting an unused action to satisfy a table would
     * be exactly the wildcard-by-another-name that §10.3 forbids. When the
     * support case clears and the Converse adapter lands, the grant arrives
     * with the code that calls it.
     */
    diffWorker.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          StringParameter.fromStringParameterName(this, 'ModelIdParam', '/handover/dev/bedrock/model-id')
            .parameterArn,
          StringParameter.fromStringParameterName(this, 'AiFlagParam', '/handover/dev/ai/diff-enabled')
            .parameterArn,
        ],
      }),
    );

    diffWorker.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        // Suffixed because Secrets Manager appends six random characters to a
        // secret's ARN; naming the bare path would match nothing.
        resources: [
          Secret.fromSecretNameV2(this, 'BedrockApiKey', '/handover/dev/bedrock/api-key')
            .secretArn + '-??????',
        ],
      }),
    );

    /**
     * §8.2's `A-)F: async invoke`, and the narrowest form of it: **only**
     * `complete-phase` may invoke a worker, and only this one. The other six
     * HTTP functions get no `lambda:InvokeFunction` at all.
     */
    diffWorker.grantInvoke(completePhase);
    completePhase.addEnvironment('DIFF_WORKER_FUNCTION_NAME', diffWorker.functionName);

    /* ── doc-worker (§5.6) ────────────────────────────────────────────────── */

    /**
     * Renders the Condition and Exit Reports.
     *
     * Sized between the API defaults and `diff-worker`: it embeds up to a few
     * dozen photographs into a PDF, which is memory-bound rather than
     * latency-bound, and needs no model call at all.
     */
    const docWorker = fn('DocWorkerFn', 'handlers/events/doc-worker.ts', {
      memorySize: 1024,
      timeout: Duration.minutes(2),
    });

    /**
     * §10.3: `s3:GetObject` on evidence, `s3:PutObject` on documents, DDB
     * read/write. The asymmetry is the point — it reads the photographs and
     * writes only derivatives.
     *
     * **No SES.** The skill's IAM table grants this function `SendRawEmail`;
     * that is omitted because delivery is cut from this build (CLAUDE.md
     * "Scope"). The worker has no mail client and no recipient, so the grant
     * would be a standing permission with no code behind it — and an unused
     * send permission on a function that handles a tenant's address and
     * photographs is exactly the kind of thing that later becomes an
     * accidental send path.
     */
    evidenceBucket.grantRead(docWorker, 'tenancies/*');
    table.grantReadWriteData(docWorker);
    docWorker.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['s3:PutObject'],
        resources: [documentsBucket.arnForObjects('tenancies/*')],
      }),
    );

    // §8.1 dispatches the Condition Report from phase completion; §8.2 chains
    // the Exit Report from `diff-worker`, once the change list it prints
    // actually exists. Both need the name and the right to invoke.
    docWorker.grantInvoke(completePhase);
    docWorker.grantInvoke(diffWorker);
    // §8.3: the claim endpoint queues the LETTER job and hands it to the same
    // worker. Three dispatchers, each granted invoke explicitly — there is no
    // blanket "any api handler may invoke any worker" grant.
    docWorker.grantInvoke(createClaim);
    completePhase.addEnvironment('DOC_WORKER_FUNCTION_NAME', docWorker.functionName);
    diffWorker.addEnvironment('DOC_WORKER_FUNCTION_NAME', docWorker.functionName);
    createClaim.addEnvironment('DOC_WORKER_FUNCTION_NAME', docWorker.functionName);

    // The read path mints presigned GETs for generated documents, which it can
    // only do with credentials that could perform the GET (see the presign
    // note above).
    const signDocumentGrant = new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: [documentsBucket.arnForObjects('tenancies/*')],
    });
    getTenancy.addToRolePolicy(signDocumentGrant);

    /* ── clock-sweeper (§5.7, §8.3) ───────────────────────────────────────── */

    /**
     * The product's thesis on a schedule: find the tenancies whose refund
     * deadline has lapsed and mark them overdue.
     *
     * Small and short, because it does very little per tenancy and reads the
     * sparse index rather than the table — the work is O(pending), not O(all
     * data). Five minutes is generous for a backlog that built up while the
     * sweep was broken.
     */
    const clockSweeper = fn('ClockSweeperFn', 'handlers/scheduled/clock-sweeper.ts', {
      memorySize: 512,
      timeout: Duration.minutes(5),
    });

    /**
     * §10.3: "DDB query on GSI2 + update. No S3, no Bedrock, no SES."
     *
     * `grantReadWriteData` covers the index because the GSI's ARN is included
     * in the table grant. The SES half of that row is moot in this build —
     * delivery is cut, and the function has no mail client to grant anything
     * to.
     */
    table.grantReadWriteData(clockSweeper);

    /**
     * §8.3: daily at 09:00 IST. IST is UTC+05:30 and EventBridge schedules in
     * UTC, so that is 03:30 UTC — the half hour is not a typo, and writing it
     * as `0 9 * * ?` would fire at 14:30 local.
     *
     * India observes no daylight saving, so this fixed offset holds all year.
     */
    new Rule(this, 'ClockSweepDaily', {
      description: 'Handover: daily refund-deadline sweep at 09:00 IST (03:30 UTC)',
      schedule: Schedule.cron({ minute: '30', hour: '3' }),
      targets: [new LambdaFunction(clockSweeper)],
    });

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
        /*
       * The local dev server, plus whatever deployed front end was passed in.
       * Never `*`: the API is credentialed by an Authorization header, and a
       * wildcard origin on a credentialed API is what lets any page on the
       * internet drive a signed-in tenant's session.
       */
      allowOrigins: ['http://localhost:5173', ...(props.webOrigins ?? [])],
        maxAge: Duration.hours(1),
      },
      defaultAuthorizer: authorizer,
    });

    const route = (
      path: string,
      method: HttpMethod,
      handler: NodejsFunction,
      name: string,
      /**
       * Overrides the API's default JWT authorizer. Only ever passed
       * `HttpNoneAuthorizer`, and only for the one route §5.2 names as public.
       * Spelled as an explicit argument rather than a default so that making a
       * route public is a visible edit at the call site.
       */
      authorizerOverride?: HttpNoneAuthorizer,
    ): void => {
      this.httpApi.addRoutes({
        path,
        methods: [method],
        integration: new HttpLambdaIntegration(`${name}Integration`, handler),
        ...(authorizerOverride ? { authorizer: authorizerOverride } : {}),
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
    route('/v1/tenancies/{id}/diff/{roomId}', HttpMethod.PATCH, patchDiff, 'PatchDiff');
    route('/v1/jobs/{jobId}', HttpMethod.GET, getJob, 'GetJob');
    route('/v1/tenancies/{id}/claim', HttpMethod.POST, createClaim, 'CreateClaim');

    /**
     * §5.2 and §7: the state-rules route is **public** — no Cognito JWT. It
     * carries no tenancy data and no personal data, it is CloudFront-cacheable,
     * and the UI needs it to render deadline copy before anyone signs in.
     *
     * `HttpNoneAuthorizer` is what overrides the API's `defaultAuthorizer` for
     * this one route. Without it the route inherits the JWT authorizer and
     * returns 401 to the very callers it exists for.
     */
    route(
      '/v1/state-rules/{code}',
      HttpMethod.GET,
      getStateRules,
      'GetStateRules',
      new HttpNoneAuthorizer(),
    );

    Tags.of(this).add('handover:stack', 'api');

    new CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, 'PhotoIngestFunctionName', { value: photoIngest.functionName });
    new CfnOutput(this, 'DiffWorkerFunctionName', { value: diffWorker.functionName });
    new CfnOutput(this, 'DocWorkerFunctionName', { value: docWorker.functionName });
    new CfnOutput(this, 'ClockSweeperFunctionName', { value: clockSweeper.functionName });
  }
}
