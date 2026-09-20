#!/usr/bin/env node
/**
 * CDK app entry — architecture.md §13.1, §13.3.
 *
 * `HandoverDev` is the dev environment. Region is `ap-south-1`, single region,
 * always (CLAUDE.md) — pinned in `lib/env.ts` rather than taken from the
 * environment, because the CLI's `CDK_DEFAULT_REGION` was silently winning and
 * synthesising every stack for `us-east-1`. The account is never written down
 * here (§10.3): it comes from `CDK_DEFAULT_ACCOUNT` at synth time, so nothing
 * in this repository carries an account id.
 */
import { App, Aspects, Tags } from 'aws-cdk-lib';
import { DataStack } from '../lib/data-stack.js';
import { AuthStack } from '../lib/auth-stack.js';
import { ApiStack } from '../lib/api-stack.js';
import { resolveEnv } from '../lib/env.js';

const app = new App();

/**
 * Region pinned, account from the environment — see `lib/env.ts`. It is not
 * read from `CDK_DEFAULT_REGION`, which the CDK CLI always sets from the
 * machine's ambient AWS configuration and which silently synthesised this
 * stack for `us-east-1`.
 */
const env = resolveEnv(app);

const stage = app.node.tryGetContext('stage') ?? 'Dev';

const data = new DataStack(app, `Handover${stage}Data`, { env });
const auth = new AuthStack(app, `Handover${stage}Auth`, { env });
const api = new ApiStack(app, `Handover${stage}Api`, {
  env,
  tableName: data.table.tableName,
  evidenceBucketName: data.evidenceBucket.bucketName,
  documentsBucketName: data.documentsBucket.bucketName,
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
});

// The references above already make api depend on data and auth. Stating it
// keeps the deploy order legible; `addStackDependency` is the non-deprecated
// spelling in aws-cdk-lib 2.270.
api.addStackDependency(data);
api.addStackDependency(auth);

Tags.of(app).add('handover:stage', String(stage));
Tags.of(app).add('handover:managed-by', 'cdk');

void Aspects;
