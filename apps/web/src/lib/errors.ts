/**
 * Backend failures, phrased for a tenant standing in a flat.
 *
 * Every API error is RFC 7807 problem+json with a stable `code` (§7), so this
 * switches on `code` — never on `status` alone and never on prose, both of
 * which drift.
 *
 * Two rules shape the copy:
 *
 * - **Nothing here ever suggests falling back to demo data.** In production a
 *   fixture shown to a real tenant would be fabricated evidence.
 * - **A failure downstream of capture is not a loss of evidence, and the copy
 *   says so.** The photographs, their hashes and their server timestamps are
 *   already stored; a report that failed to generate is a retry, not a
 *   catastrophe. Saying otherwise would frighten someone out of a valid claim.
 */
import type { ApiErrorCode } from '@handover/shared';
import { ApiError, NetworkError } from './api-client.js';
import { AuthError } from './auth/auth-error.js';

export interface UserFacingError {
  readonly title: string;
  readonly detail: string;
  /** True when trying the same thing again is a sensible next step. */
  readonly retryable: boolean;
  /** True when the only way forward is to sign in again. */
  readonly requiresSignIn: boolean;
}

const BY_CODE: Readonly<Record<ApiErrorCode, Omit<UserFacingError, 'requiresSignIn'>>> = {
  UNKNOWN_STATE: {
    title: 'That state is not set up yet',
    detail: 'Only Karnataka is configured in this build.',
    retryable: false,
  },
  INVALID_DEPOSIT: {
    title: 'Check the deposit amount',
    detail: 'The deposit must be greater than zero.',
    retryable: false,
  },
  TENANCY_QUOTA: {
    title: 'Daily limit reached',
    detail: 'You have created the maximum number of tenancies for today. Try again tomorrow.',
    retryable: false,
  },
  PHASE_ALREADY_COMPLETE: {
    title: 'This stage is already closed',
    detail: 'The photographs for this stage have already been submitted.',
    retryable: false,
  },
  INGEST_INCOMPLETE: {
    title: 'Still recording your photographs',
    detail:
      'Some photographs have not finished being recorded yet. Nothing is lost — wait a moment and try again.',
    retryable: true,
  },
  EMPTY_ROOM: {
    title: 'A room has no photographs',
    detail: 'Every room needs at least one photograph before this stage can be closed.',
    retryable: false,
  },
  NOT_FOUND: {
    title: 'Not found',
    detail: 'This tenancy is not available on your account.',
    retryable: false,
  },
  FORBIDDEN: {
    title: 'Not found',
    // Deliberately identical to NOT_FOUND: §7 says not to let the UI
    // distinguish them, or the API becomes an existence oracle for other
    // people's tenancies.
    detail: 'This tenancy is not available on your account.',
    retryable: false,
  },
  VALIDATION_FAILED: {
    title: 'Something in that request was not accepted',
    detail: 'Check the details and try again.',
    retryable: false,
  },
  SEND_QUOTA: {
    title: 'Send limit reached',
    detail: 'Email delivery is not part of this build.',
    retryable: false,
  },
  INTERNAL: {
    title: 'Something went wrong at our end',
    detail:
      'Your photographs and their timestamps are unaffected. Try again in a moment.',
    retryable: true,
  },
};

/** Maps any thrown value onto copy a screen can render. */
export function toUserFacingError(error: unknown): UserFacingError {
  if (error instanceof ApiError) {
    const base = BY_CODE[error.code];
    return {
      ...base,
      // The authorizer rejects before any handler runs, so a 401 is a dead
      // session rather than a permissions problem on a real resource.
      requiresSignIn: error.problem.status === 401,
      ...(error.problem.detail ? { detail: base.detail } : {}),
    };
  }

  if (error instanceof AuthError) {
    return {
      title: 'Could not sign in',
      detail: error.message,
      retryable: true,
      requiresSignIn: true,
    };
  }

  if (error instanceof NetworkError) {
    return {
      title: 'Could not reach the server',
      detail:
        'Check your connection and try again. Photographs already sent are unaffected.',
      retryable: true,
      requiresSignIn: false,
    };
  }

  return {
    title: 'Something went wrong',
    detail: error instanceof Error ? error.message : String(error),
    retryable: true,
    requiresSignIn: false,
  };
}

/**
 * True when a route the contract defines is not deployed on this stage.
 *
 * API Gateway answers an unregistered route with a bare `404 {"message":"Not
 * Found"}` — no problem+json, so it surfaces as a synthetic INTERNAL. That is
 * a very different thing from "this tenancy does not exist", and the UI has to
 * say so rather than implying the tenant's data is missing.
 */
export function isRouteNotDeployed(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.problem.status === 404 &&
    error.problem.code === 'INTERNAL'
  );
}
