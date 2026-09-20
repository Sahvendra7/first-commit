#!/usr/bin/env node
/**
 * CDK app entry — architecture.md §13.1, §13.3.
 *
 * `HandoverDev` is the dev environment. Region is `ap-south-1`, single region,
 * always (CLAUDE.md). The account is never written down here (§10.3): it comes
 * from `CDK_DEFAULT_ACCOUNT` at synth time, so nothing in this repository
 * carries an account id.
 */
import { App, Aspects, Tags } from 'aws-cdk-lib';
import { DataStack } from '../lib/data-stack.js';
import { AuthStack } from '../lib/auth-stack.js';
import { ApiStack } from '../lib/api-stack.js';
import { WebStack } from '../lib/web-stack.js';

const app = new App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-south-1',
};

const stage = app.node.tryGetContext('stage') ?? 'Dev';

/**
 * The deployed front end's origin, for the API's CORS allow-list.
 *
 * Supplied on the command line after `WebStack` has been created, because the
 * CloudFront domain does not exist before then:
 *
 *     cdk deploy HandoverDevWeb
 *     cdk deploy HandoverDevApi -c webOrigin=https://dxxxx.cloudfront.net
 *
 * Absent, the API allows the local dev server only — which is the right
 * default for a stage with no deployed front end, and fails loudly in the
 * browser rather than silently allowing everything.
 */
const webOrigin = app.node.tryGetContext('webOrigin');
const webOrigins: string[] = typeof webOrigin === 'string' && webOrigin.trim() !== ''
  ? [webOrigin.trim().replace(/\/+$/, '')]
  : [];

const data = new DataStack(app, `Handover${stage}Data`, { env });
const auth = new AuthStack(app, `Handover${stage}Auth`, { env });
const api = new ApiStack(app, `Handover${stage}Api`, {
  env,
  tableName: data.table.tableName,
  evidenceBucketName: data.evidenceBucket.bucketName,
  documentsBucketName: data.documentsBucket.bucketName,
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
  webOrigins,
});

/**
 * Static hosting on S3 + CloudFront. Deliberately independent of the other
 * three: it holds build output only, so it can be created, destroyed and
 * redeployed without touching the evidence, the table or the API.
 *
 * **Opt-in, because CloudFront is not available on this account.** A deploy
 * fails at the distribution with:
 *
 *   Your account must be verified before you can add new CloudFront
 *   resources. To verify your account, please contact AWS Support.
 *
 * That is an account-level gate, not a template error — the same class of
 * blocker as the Bedrock one in CLAUDE.md. The stack is kept because it is the
 * intended long-term hosting and is ready the day verification lands; it is
 * gated so that `cdk deploy --all` does not fail on a stack that cannot
 * succeed. Until then the deployed front end is Amplify Hosting
 * (`apps/web/scripts/deploy.sh`), which fronts its own CloudFront and needs no
 * verification on this account.
 *
 *     cdk deploy Handover${stage}Web -c hosting=cloudfront
 */
if (app.node.tryGetContext('hosting') === 'cloudfront') {
  new WebStack(app, `Handover${stage}Web`, { env });
}

// The references above already make api depend on data and auth. Stating it
// keeps the deploy order legible; `addStackDependency` is the non-deprecated
// spelling in aws-cdk-lib 2.270.
api.addStackDependency(data);
api.addStackDependency(auth);

Tags.of(app).add('handover:stage', String(stage));
Tags.of(app).add('handover:managed-by', 'cdk');

void Aspects;
