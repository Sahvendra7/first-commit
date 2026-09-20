/**
 * Feature flags from SSM Parameter Store — architecture.md §9.6, §10.3.
 *
 * One flag today: whether the AI suggestion layer runs at all.
 *
 * §9.6 makes tier 3 — the evidence ledger — the product, and puts the model's
 * change list "behind an SSM feature flag, off by default until the eval says
 * otherwise". Two properties follow, and both are enforced here rather than
 * left to a caller's care:
 *
 *  - **Absent means off.** A parameter that does not exist, is empty, or holds
 *    anything other than an explicit affirmative resolves to `false`. The flag
 *    has to be switched *on* deliberately; it can never be on by accident,
 *    by a typo, or because a deploy forgot to create it.
 *  - **An error means off.** If SSM is unreachable or the read is denied, the
 *    answer is `false`. Fail-closed is the only defensible direction: the
 *    failure mode of a wrongly-off flag is a room the tenant annotates by
 *    hand, and the failure mode of a wrongly-on flag is model output on a
 *    record that was supposed to be code-derived.
 *
 * Resolved once per container. A flag flip takes effect on the next cold
 * start, which is the right trade for a value read on every job.
 */
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

/** §9.6's flag. Off unless this parameter says otherwise. */
export const AI_DIFF_ENABLED_PARAMETER = '/handover/dev/ai/diff-enabled';

/**
 * The only two spellings that mean "on".
 *
 * Deliberately not `Boolean(value)` and not "anything but false": a parameter
 * accidentally set to `0`, `off`, `no` or `disabled` must not enable the model.
 */
const AFFIRMATIVE = new Set(['true', '1']);

export interface FeatureFlagDeps {
  readonly ssm?: SSMClient;
  readonly env?: Record<string, string | undefined>;
  readonly logger?: { warn(event: string, fields: Record<string, unknown>): void };
}

const defaultLogger = {
  warn: (event: string, fields: Record<string, unknown>): void =>
    console.warn(JSON.stringify({ level: 'WARN', event, ...fields })),
};

let client: SSMClient | undefined;
let cached: Promise<boolean> | undefined;

async function read(deps: FeatureFlagDeps): Promise<boolean> {
  const env = deps.env ?? process.env;

  // Local and eval runs need a way to exercise the enabled path without an
  // AWS round trip. It is read with the same strictness as the parameter.
  const override = env['AI_DIFF_ENABLED'];
  if (override !== undefined && override.trim() !== '') {
    return AFFIRMATIVE.has(override.trim().toLowerCase());
  }

  const name = env['AI_DIFF_ENABLED_PARAMETER'] ?? AI_DIFF_ENABLED_PARAMETER;
  const ssm = deps.ssm ?? (client ??= new SSMClient({}));

  const result = await ssm.send(new GetParameterCommand({ Name: name }));
  const value = result.Parameter?.Value?.trim().toLowerCase();
  return value !== undefined && AFFIRMATIVE.has(value);
}

/**
 * Is the AI suggestion layer enabled? Resolved once per container.
 *
 * A read that *failed* is not memoised — a missing parameter may be created,
 * or a denied read granted, without a redeploy, and a cached rejection would
 * outlive the fix. A read that succeeded is memoised whatever it said,
 * including `false`, because the off state is the normal one and re-reading
 * SSM on every job to re-learn it is work for nothing.
 */
export async function aiDiffEnabled(deps: FeatureFlagDeps = {}): Promise<boolean> {
  cached ??= read(deps).catch((error: unknown) => {
    (deps.logger ?? defaultLogger).warn('feature_flag_read_failed', {
      parameter: deps.env?.['AI_DIFF_ENABLED_PARAMETER'] ?? AI_DIFF_ENABLED_PARAMETER,
      // The name of the error, never its message: an SDK message can carry an
      // ARN and therefore an account id (§10.3).
      error: (error as Error)?.name ?? 'unknown',
      resolvedTo: false,
    });
    cached = undefined;
    return false;
  });
  return cached;
}

/** Test seam: drop the memoised value and the lazily built client. */
export function resetFeatureFlagCache(): void {
  cached = undefined;
  client = undefined;
}
