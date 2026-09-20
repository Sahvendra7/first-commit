/**
 * HTTP plumbing — architecture.md §5.3, §7, §10.2.
 *
 * §5.3 says handlers are thin adapters: parse, authorize, call the domain,
 * serialise. Everything in this file is one of those four verbs. No business
 * rule lives here.
 *
 * Errors are RFC 7807 problem+json with a stable `code`, per §7, and the codes
 * come from the shared `API_ERROR_CODES` list so the client cannot drift.
 */
import { ZodError } from 'zod';
import { problemSchema } from '@handover/shared';
import { UnsignedEvidenceError } from '../../domain/evidence/aggregate.js';
import type { ApiErrorCode } from '@handover/shared';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { ZodSchema } from 'zod';

export type ApiEvent = APIGatewayProxyEventV2WithJWTAuthorizer;
export type ApiResult = APIGatewayProxyResultV2;

const JSON_HEADERS = { 'content-type': 'application/json' } as const;
const PROBLEM_HEADERS = { 'content-type': 'application/problem+json' } as const;

/** A refusal that carries its own HTTP status and stable code. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly detail?: string;

  constructor(status: number, code: ApiErrorCode, detail?: string) {
    super(detail ?? code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export function ok(body: unknown, status = 200): ApiResult {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

/** RFC 7807 problem+json (§7). */
export function problem(status: number, code: ApiErrorCode, detail?: string): ApiResult {
  const body = problemSchema.parse({
    type: `https://handover.example/problems/${code.toLowerCase().replace(/_/g, '-')}`,
    title: code,
    status,
    code,
    ...(detail ? { detail } : {}),
  });
  return { statusCode: status, headers: PROBLEM_HEADERS, body: JSON.stringify(body) };
}

/**
 * The caller's Cognito `sub`, from the JWT the API Gateway authorizer already
 * verified.
 *
 * §7 and §10.1: the owner id is *never* read from a body, a query string or a
 * client-set header. This is the only function in the codebase that produces
 * one, so there is exactly one place to audit.
 */
export function callerSub(event: ApiEvent): string {
  const claims = event.requestContext?.authorizer?.jwt?.claims as
    | Record<string, unknown>
    | undefined;
  const sub = claims?.['sub'];
  if (typeof sub !== 'string' || sub.trim().length === 0) {
    throw new HttpError(401 as const, 'FORBIDDEN', 'No verified subject on the request');
  }
  return sub.trim();
}

/** Parse and validate a JSON body against a shared schema. */
export function parseBody<T>(event: ApiEvent, schema: ZodSchema<T>): T {
  let raw: unknown;
  try {
    const text = event.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : (event.body ?? '');
    raw = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'VALIDATION_FAILED', 'Body is not valid JSON');
  }
  return parse(schema, raw);
}

/** Validate already-extracted values (path parameters, for instance). */
export function parse<T>(schema: ZodSchema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, 'VALIDATION_FAILED', formatZod(result.error));
  }
  return result.data;
}

function formatZod(error: ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .slice(0, 8)
    .join('; ');
}

/**
 * Turn an unsignable-evidence failure into a 503 the client can retry.
 *
 * Shared by both read paths, because both assemble evidence and both must
 * refuse to under-report it (see `UnsignedEvidenceError`).
 *
 * 503 rather than 500: the evidence is intact and the request is not
 * malformed — this attempt could not render it, and the next one probably
 * can, because a signing failure is almost always a transient credential
 * problem rather than a property of the object. The photo ids go to the log,
 * where an operator can act on them, and never into the response body: an S3
 * key carries the tenancy id and the room id (§10.1).
 */
export function rethrowUnsigned(err: unknown, tenancyId: string): never {
  if (err instanceof UnsignedEvidenceError) {
    console.error('evidence_unsignable', {
      tenancyId,
      photoIds: err.photoIds,
      count: err.s3Keys.length,
    });
    throw new HttpError(
      503,
      'INTERNAL',
      'Evidence could not be prepared for download. Please retry.',
    );
  }
  throw err;
}

/**
 * Wrap a handler so every throw becomes a problem+json response.
 *
 * The default branch is deliberately opaque: an unexpected error returns
 * `INTERNAL` with no detail. The assets here are photographs of people's homes
 * and their addresses (§10.1), and an exception message is exactly the kind of
 * thing that leaks a key or an id into a response body.
 */
export function withErrors(
  fn: (event: ApiEvent) => Promise<ApiResult>,
): (event: ApiEvent) => Promise<ApiResult> {
  return async (event: ApiEvent): Promise<ApiResult> => {
    try {
      return await fn(event);
    } catch (err) {
      if (err instanceof HttpError) return problem(err.status, err.code, err.detail);
      if (err instanceof ZodError) return problem(400, 'VALIDATION_FAILED', formatZod(err));
      console.error('unhandled_handler_error', {
        name: (err as Error)?.name,
        message: (err as Error)?.message,
      });
      return problem(500, 'INTERNAL');
    }
  };
}
