/**
 * The deployment environment — CLAUDE.md: "Region is `ap-south-1`. Single
 * region, always."
 *
 * ── Why this is not `process.env.CDK_DEFAULT_REGION` ────────────────────────
 * It used to be, with `?? 'ap-south-1'` as a fallback, and the fallback never
 * fired: the CDK CLI **always** sets `CDK_DEFAULT_REGION` in the app's
 * subprocess, resolved from whatever ambient AWS configuration the machine
 * running `cdk` happens to have. On a laptop configured for `us-east-1`, or in
 * a container with no configuration at all — where the SDK falls back to
 * `us-east-1` — the whole stack synthesised for the wrong region, silently.
 *
 * That is not a cosmetic bug. The evidence bucket is `RETAIN` and
 * delete-denied; a deploy that created it in the wrong region would leave a
 * bucket nobody meant to make, holding photographs of someone's home, in a
 * jurisdiction the product did not choose. §10.5's privacy posture and the
 * single-region constraint are the same decision.
 *
 * So the region is **pinned**, read from `cdk.json` context (where
 * `handover:region` was already declared and unused) and never from the
 * environment. Overriding it is possible — `cdk deploy -c handover:region=…` —
 * but it is now a deliberate act at the command line rather than a property of
 * whoever happens to be running the deploy.
 *
 * The **account** is still taken from the environment, because §10.3 forbids
 * an account id in a committed file. An absent account makes the stack
 * environment-agnostic, which is correct: it deploys to whichever account the
 * credentials belong to, in the region we chose.
 */
import type { Environment } from 'aws-cdk-lib';
import type { App } from 'aws-cdk-lib';

/** The only region this system deploys to. */
export const HANDOVER_REGION = 'ap-south-1';

/** Context key, matching the entry already present in `cdk.json`. */
export const REGION_CONTEXT_KEY = 'handover:region';

/**
 * Resolve the deployment environment.
 *
 * `region` comes from context and falls back to the constant — never from
 * `CDK_DEFAULT_REGION`, which the CLI overwrites. `account` comes from
 * `CDK_DEFAULT_ACCOUNT` so no account id is ever written down (§10.3).
 */
export function resolveEnv(app: App): Environment {
  const fromContext = app.node.tryGetContext(REGION_CONTEXT_KEY) as unknown;
  const region =
    typeof fromContext === 'string' && fromContext.trim().length > 0
      ? fromContext.trim()
      : HANDOVER_REGION;

  return {
    account: process.env['CDK_DEFAULT_ACCOUNT'],
    region,
  };
}
