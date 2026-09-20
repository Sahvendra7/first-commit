/**
 * Runtime configuration, read once from the Vite environment.
 *
 * Nothing in this file is a secret and nothing in it may become one. A Cognito
 * user pool id and app client id are public by construction — they ship inside
 * every browser bundle of every Cognito SPA — but they are still environment,
 * not code: they differ per stage, and hardcoding them would make the bundle
 * unusable anywhere but one account. The API base URL is the same.
 *
 * What must never appear here, or anywhere in this repository: an AWS account
 * id, an access key, a Cognito **client secret** (the web client is created
 * without one on purpose — a public SPA cannot hold a secret), or a token.
 * `.env*` is gitignored; `.env.example` carries placeholders only.
 */

/** Everything the app needs to talk to a deployed stage. */
export interface AppConfig {
  /** e.g. `https://xxxx.execute-api.ap-south-1.amazonaws.com`. No trailing slash. */
  readonly apiBaseUrl: string;
  readonly cognito: {
    readonly region: string;
    /** e.g. `ap-south-1_XXXXXXXXX`. */
    readonly userPoolId: string;
    /** The public app client id. Never a client secret. */
    readonly userPoolClientId: string;
  };
}

/** Why the app cannot start, phrased for a person rather than a log. */
export class ConfigError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`Missing configuration: ${missing.join(', ')}`);
    this.name = 'ConfigError';
    this.missing = missing;
  }
}

function read(env: Record<string, unknown>, key: string): string {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Reads and validates configuration.
 *
 * Throws rather than defaulting. A base URL that silently falls back to the
 * current origin produces 404s against the web server and looks like a backend
 * outage; a missing pool id produces an auth failure that looks like a wrong
 * password. Both waste far more time than an explicit refusal to start.
 */
export function loadConfig(
  env: Record<string, unknown> = import.meta.env as unknown as Record<string, unknown>,
): AppConfig {
  const apiBaseUrl = read(env, 'VITE_API_BASE_URL').replace(/\/+$/, '');
  const userPoolId = read(env, 'VITE_COGNITO_USER_POOL_ID');
  const userPoolClientId = read(env, 'VITE_COGNITO_CLIENT_ID');
  // The pool id is `<region>_<suffix>`, so the region is derivable; the
  // override exists only for the unusual case of an API in another region.
  const region = read(env, 'VITE_AWS_REGION') || userPoolId.split('_')[0] || 'ap-south-1';

  const missing: string[] = [];
  if (!apiBaseUrl) missing.push('VITE_API_BASE_URL');
  if (!userPoolId) missing.push('VITE_COGNITO_USER_POOL_ID');
  if (!userPoolClientId) missing.push('VITE_COGNITO_CLIENT_ID');
  if (missing.length > 0) throw new ConfigError(missing);

  return { apiBaseUrl, cognito: { region, userPoolId, userPoolClientId } };
}

/**
 * Non-throwing variant, so a screen can render a "not configured" state rather
 * than a blank page with a console error.
 */
export function tryLoadConfig(
  env?: Record<string, unknown>,
): { ok: true; config: AppConfig } | { ok: false; error: ConfigError } {
  try {
    return { ok: true, config: loadConfig(env) };
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, error };
    throw error;
  }
}
