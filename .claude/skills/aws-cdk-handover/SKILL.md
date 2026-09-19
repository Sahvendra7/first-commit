---
name: aws-cdk-handover
description: Use when writing, reviewing or deploying anything under infra/cdk — stacks, Lambda functions, buckets, tables, IAM. Enforces the four-stack split, Node 20/ARM64 in ap-south-1, the non-negotiable evidence-integrity settings, and per-function least privilege.
---

# CDK rules

## Stack split — exactly four

- `data-stack.ts` — DynamoDB table, both S3 buckets, lifecycle rules, bucket policies
- `auth-stack.ts` — Cognito user pool. Hosted UI, **unthemed**. Do not spend time on it.
- `api-stack.ts` — API Gateway HTTP API, the five Lambdas, IAM roles
- `ops-stack.ts` — the five alarms, DLQs, budget alert

Do not add a fifth stack. Do not merge them.

## Function defaults

Every Lambda: `runtime: NODEJS_20_X`, `architecture: ARM_64`, region
`ap-south-1`. `diff-worker`: timeout 300s, memory 1024 MB. The five functions
share one bundled codebase — deployment units, not services. Deploy together.

## Non-negotiable — cut anything else first

These are the entire basis of the product's claim to be evidence rather than a
photo album (§15.4):

- **S3 evidence bucket: versioning ON.**
- **Bucket policy explicitly denying `s3:DeleteObjectVersion`** (and object
  overwrite) to all principals.
- Both buckets: `blockPublicAccess: BLOCK_ALL`, SSE-S3, `removalPolicy: RETAIN`.
- Documents bucket versioned too, reachable only via presigned GET ≤ 5 min.
- **DynamoDB: point-in-time recovery ON**, on-demand billing, TTL attribute
  enabled (jobs 7 days, diff cache 90 days).

Lifecycle on evidence: Standard-IA at 90 days, Glacier IR at 2 years.

## IAM — least privilege per function (§10.3)

| Function | Grants | Explicitly denied / omitted |
|---|---|---|
| `api-handler` | DDB RW, `s3:PutObject` on the upload prefix (presign only), `lambda:InvokeFunction` on the two async workers, SSM read | **no `s3:GetObject`**, no Bedrock, no SES |
| `photo-ingest` | `s3:GetObject` on evidence, DDB write | no presign, no Bedrock, no SES |
| `diff-worker` | `s3:GetObject`, `bedrock:InvokeModel`, DDB RW | **no SES** |
| `doc-worker` | `s3:GetObject` evidence, `s3:PutObject` documents, `bedrock:InvokeModel`, SES `SendRawEmail` **restricted by configuration set**, DDB RW | — |
| `clock-sweeper` | DDB query on GSI2 + update, SES send | no S3, no Bedrock |

Never use a wildcard resource where a bucket prefix or table ARN will do. Never
grant a function a permission the table above does not list for it.

## Other

No secrets in environment variables or in the repo. Feature flags, model IDs and
prompt-version pointers go in SSM Parameter Store. No AWS account ID in a
committed file — read it from context or an env var at synth time.

If CDK is fighting you on day one, deploy from the console and codify by day
four (§15.4). Shipping beats purity — except for versioning, deny-delete and
PITR, which are never what you cut.
