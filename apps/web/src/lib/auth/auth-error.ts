/**
 * The auth failures, in a module that does not pull in Cognito.
 *
 * These are plain `Error` subclasses with no dependency on
 * `amazon-cognito-identity-js` — but they used to live next to `CognitoAuth`,
 * and `lib/errors.ts` imports `AuthError` to map a dead session onto the
 * sign-in boundary. `errors.ts` is imported by nearly every screen, so that one
 * `instanceof` check dragged ~250KB of SRP implementation into the entry chunk
 * of a page that, in demo mode, has no account at all.
 *
 * Splitting them out is what lets `cognito-auth.ts` be dynamically imported for
 * real. `cognito-auth.ts` re-exports both, so nothing that already imported
 * them from there had to change.
 */

export class AuthError extends Error {
  /** Cognito's exception name, e.g. `NotAuthorizedException`. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

/** Raised when Cognito requires a new password before it will issue tokens. */
export class NewPasswordRequiredError extends AuthError {
  constructor() {
    super('NewPasswordRequired', 'This account must set a new password before signing in.');
    this.name = 'NewPasswordRequiredError';
  }
}
