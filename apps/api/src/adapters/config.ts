/**
 * Runtime configuration — architecture.md §10.3.
 *
 * Resource *names* come from the environment, which CDK populates at deploy
 * time. Secrets do not: §10.3 is explicit that "no secret is ever in an
 * environment variable or in the repository", and there are effectively none
 * here because IAM roles cover S3, DynamoDB and Bedrock. Feature flags and
 * model ids live in SSM, read at runtime by the code that needs them.
 *
 * Read lazily rather than at module load, so a unit test can set the
 * environment after import and a missing variable fails the request that needs
 * it rather than the cold start of every function in the bundle.
 */

export class MissingConfigError extends Error {
  constructor(name: string) {
    super(`Missing required environment variable ${name}`);
    this.name = 'MissingConfigError';
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) throw new MissingConfigError(name);
  return value.trim();
}

/** Single region, always (CLAUDE.md). */
export const REGION = 'ap-south-1';

export const config = {
  tableName: (): string => required('TABLE_NAME'),
  evidenceBucket: (): string => required('EVIDENCE_BUCKET'),
  documentsBucket: (): string => required('DOCUMENTS_BUCKET'),
  region: (): string => process.env.AWS_REGION?.trim() || REGION,
} as const;
