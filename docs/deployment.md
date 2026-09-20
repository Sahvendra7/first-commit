# Deployment

Region is `ap-south-1`, single region, always. Nothing here holds a secret: the
Cognito pool id and public app client id ship inside every browser bundle of
every Cognito SPA, and the account id is never written down in this repository
(§10.3) — it comes from `CDK_DEFAULT_ACCOUNT` at synth time.

## Stacks

| Stack                | What it holds                                       |
| -------------------- | --------------------------------------------------- |
| `HandoverDevData`    | DynamoDB single table, evidence and documents buckets |
| `HandoverDevAuth`    | Cognito user pool and the public web client          |
| `HandoverDevApi`     | HTTP API, the five Lambdas, the JWT authorizer        |
| `HandoverDevWeb`     | S3 + CloudFront static hosting — **opt-in, see below** |

```bash
pnpm --filter @handover/cdk exec cdk deploy HandoverDevData HandoverDevAuth HandoverDevApi
```

## Front end

```bash
AWS_PROFILE=handover-dev apps/web/scripts/deploy.sh
```

The script reads the API URL, pool id and client id from CloudFormation outputs
rather than taking them as arguments, so a build configured for one stage cannot
be published into another's app. It refuses to upload a bundle that contains
anything credential-shaped, that mentions demo mode in `index.html`, or that was
built without an API URL — an upload is publication, and publication is not
undone by deleting a file.

It is idempotent: it reuses the Amplify app if one exists, re-applies the SPA
rewrite rules every run so they cannot drift, and smoke-tests the result before
it reports success.

### CORS

A new front-end origin has to be added to the API's allow-list, which is a
parameter rather than a cross-stack reference so the API stays deployable before
any front end exists:

```bash
pnpm --filter @handover/cdk exec cdk deploy HandoverDevApi \
  -c webOrigin=https://main.d1zya6h06dudbc.amplifyapp.com
```

Never `*`. The API is credentialed by an `Authorization` header, and a wildcard
origin on a credentialed API is what lets any page on the internet drive a
signed-in tenant's session.

## Hosting: why Amplify, for now

`infra/cdk/lib/web-stack.ts` describes S3 + CloudFront with Origin Access
Control, a private bucket, SPA rewrites and split caching. It is the intended
hosting and it synthesises and tests clean. It **cannot be deployed on this
account**:

```
Your account must be verified before you can add new CloudFront resources.
To verify your account, please contact AWS Support.
```

That is an account-level gate, not a template error — the same class of blocker
as the Bedrock one recorded in `CLAUDE.md`. Everything up to the distribution
creates successfully; only `AWS::CloudFront::Distribution` is refused.

So the stack is kept and gated behind a context flag, which keeps
`cdk deploy --all` from failing on a stack that cannot succeed:

```bash
# Once the account is verified:
pnpm --filter @handover/cdk exec cdk deploy HandoverDevWeb -c hosting=cloudfront
```

Until then the deployed front end is **Amplify Hosting**, which fronts its own
CloudFront distribution, needs no verification on this account, and provides
HTTPS, SPA rewrites and a public URL. Switching back is a deploy and a
`webOrigin`, not a code change.

## Cache behaviour

`/assets/*` is content-hashed by Vite and is immutable. `index.html` and `sw.js`
must never be held for long: a stale `index.html` points at assets that no longer
exist, and a stale service worker keeps serving the old shell to a returning
device for as long as its TTL — the classic way a PWA pins itself to a dead
build. The CloudFront stack expresses this as two cache policies; Amplify
applies its own defaults, and a deploy invalidates them.

## What is deliberately not deployed

- **SES and any send path.** Cut from the MVP (`CLAUDE.md`). Documents are
  generated as PDFs and downloaded.
- **The AI suggestion layer.** Behind an SSM flag, off by default. Rooms come
  back `NEEDS_REVIEW` with `reviewReason: 'AI_DISABLED'`, which the UI presents
  as the ordinary manual path rather than as a failure.
- **Any state but Karnataka.** One entry, to prove the rules are data-driven.
