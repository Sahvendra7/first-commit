/**
 * The Cognito boundary — architecture.md §10.2.
 *
 * §10.2 is explicit: "No custom auth. No password handling in application code
 * — ever." This module is the smallest thing that honours that against the
 * deployed pool: register, confirm a registration, sign in, answer a forced
 * password change, hand out a current ID token, and sign out. Every one of
 * those is a call into `amazon-cognito-identity-js`; none of them inspects,
 * stores or forwards a password.
 *
 * Three properties of the deployed stack decide the shape, and each was read
 * from `infra/cdk/lib/auth-stack.ts` rather than assumed:
 *
 * 1. **SRP only.** The app client enables `userSrp` and nothing else, so
 *    `USER_PASSWORD_AUTH` is not available. Under SRP the password is never
 *    transmitted — it derives a proof. That is why this file can say it does no
 *    password handling: it passes the password straight to the SRP exchange and
 *    never stores, logs or forwards it.
 * 2. **No hosted UI.** The pool has no domain and no callback URLs, so there is
 *    no OAuth redirect flow to use. Sign-in has to happen in-app.
 * 3. **The authorizer sets `jwtAudience` to the app client id.** A Cognito
 *    *access* token carries `client_id`, not `aud`; only the **ID token** has
 *    `aud`. So the ID token is what the API accepts, and `getIdToken` below is
 *    named for the thing it must return.
 */
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserAttribute,
  CognitoUserPool,
  CognitoUserSession,
} from 'amazon-cognito-identity-js';
import type { AppConfig } from '../config.js';
import { AuthError, NewPasswordRequiredError } from './auth-error.js';
import { MemoryStorage } from './memory-storage.js';

/*
 * Re-exported so every existing importer keeps working. They live in
 * `auth-error.ts` because `lib/errors.ts` needs `AuthError` on every screen and
 * must not drag the Cognito SDK in with it — see that file's header.
 */
export { AuthError, NewPasswordRequiredError };

/** Refresh this far ahead of expiry, so a request never races the clock. */
const REFRESH_MARGIN_MS = 60_000;

export interface AuthUser {
  readonly email: string;
  /** The verified Cognito subject. Shown for support, never sent in a body. */
  readonly sub: string;
}

function messageFor(error: unknown): { code: string; message: string } {
  const err = error as { code?: string; name?: string; message?: string };
  const code = err?.code ?? err?.name ?? 'UnknownError';
  switch (code) {
    case 'NotAuthorizedException':
      return { code, message: 'That email address and password do not match.' };
    case 'UserNotFoundException':
      // preventUserExistenceErrors is on, so this should not surface; the copy
      // matches NotAuthorized anyway so the two cannot be told apart.
      return { code, message: 'That email address and password do not match.' };
    case 'UsernameExistsException':
      return { code, message: 'An account already exists for that email address.' };
    case 'InvalidPasswordException':
      return {
        code,
        message:
          'Choose a password of at least 12 characters, with an uppercase letter, a lowercase letter and a digit.',
      };
    case 'InvalidParameterException':
      return { code, message: 'Check the email address and password and try again.' };
    case 'CodeMismatchException':
      return { code, message: 'That code is not right. Check it and try again.' };
    case 'ExpiredCodeException':
      return { code, message: 'That code has expired. Ask for a new one.' };
    case 'UserNotConfirmedException':
      return { code, message: 'This account has not been verified yet. Check your email.' };
    case 'PasswordResetRequiredException':
      return { code, message: 'This account needs a password reset before you can sign in.' };
    case 'TooManyRequestsException':
    case 'LimitExceededException':
      return { code, message: 'Too many attempts. Wait a minute and try again.' };
    case 'NetworkError':
      return { code, message: 'Could not reach the sign-in service.' };
    default:
      return { code, message: err?.message ?? 'Sign-in failed.' };
  }
}

export class CognitoAuth {
  readonly #pool: CognitoUserPool;
  readonly #storage = new MemoryStorage();
  #session?: CognitoUserSession;
  #user?: CognitoUser;
  /** Set when Cognito demands a new password, so `completeNewPassword` can resume. */
  #pendingUser?: CognitoUser;

  constructor(config: AppConfig) {
    this.#pool = new CognitoUserPool({
      UserPoolId: config.cognito.userPoolId,
      ClientId: config.cognito.userPoolClientId,
      // Nothing reaches localStorage — see MemoryStorage.
      Storage: this.#storage,
    });
  }

  get isSignedIn(): boolean {
    return this.#session?.isValid() === true;
  }

  get currentUser(): AuthUser | undefined {
    if (!this.#session) return undefined;
    const payload = this.#session.getIdToken().payload as Record<string, unknown>;
    const email = typeof payload['email'] === 'string' ? payload['email'] : '';
    const sub = typeof payload['sub'] === 'string' ? payload['sub'] : '';
    return { email, sub };
  }

  /**
   * Registers a new account. `selfSignUpEnabled` is true on the deployed pool
   * and `autoVerify: { email: true }` means Cognito emails a six-digit code,
   * so a registration is not usable until `confirmSignUp` runs.
   *
   * Resolves to whether confirmation is still outstanding, rather than to a
   * session: there is no session yet, and returning one would be a lie.
   */
  signUp(email: string, password: string): Promise<{ confirmed: boolean }> {
    return new Promise((resolve, reject) => {
      this.#pool.signUp(
        email,
        password,
        // `email` is a required, immutable standard attribute on the pool.
        [new CognitoUserAttribute({ Name: 'email', Value: email })],
        [],
        (error, result) => {
          if (error || !result) {
            const { code, message } = messageFor(error);
            reject(new AuthError(code, message));
            return;
          }
          resolve({ confirmed: result.userConfirmed === true });
        },
      );
    });
  }

  /** Answers the emailed verification code. */
  confirmSignUp(email: string, code: string): Promise<void> {
    const user = new CognitoUser({
      Username: email,
      Pool: this.#pool,
      Storage: this.#storage,
    });
    return new Promise((resolve, reject) => {
      user.confirmRegistration(code, true, (error) => {
        if (error) {
          const { code: errorCode, message } = messageFor(error);
          reject(new AuthError(errorCode, message));
          return;
        }
        resolve();
      });
    });
  }

  /** Sends a fresh verification code to an unconfirmed account. */
  resendConfirmationCode(email: string): Promise<void> {
    const user = new CognitoUser({
      Username: email,
      Pool: this.#pool,
      Storage: this.#storage,
    });
    return new Promise((resolve, reject) => {
      user.resendConfirmationCode((error) => {
        if (error) {
          const { code, message } = messageFor(error);
          reject(new AuthError(code, message));
          return;
        }
        resolve();
      });
    });
  }

  signIn(email: string, password: string): Promise<AuthUser> {
    const user = new CognitoUser({
      Username: email,
      Pool: this.#pool,
      Storage: this.#storage,
    });
    const details = new AuthenticationDetails({ Username: email, Password: password });

    return new Promise<AuthUser>((resolve, reject) => {
      user.authenticateUser(details, {
        onSuccess: (session) => {
          this.#session = session;
          this.#user = user;
          this.#pendingUser = undefined;
          const current = this.currentUser;
          if (!current) {
            reject(new AuthError('NoIdToken', 'Cognito returned no ID token.'));
            return;
          }
          resolve(current);
        },
        onFailure: (error) => {
          const { code, message } = messageFor(error);
          reject(new AuthError(code, message));
        },
        newPasswordRequired: () => {
          // A pool-created user on first sign-in. Keep the handle so the caller
          // can finish the challenge without re-entering the old password.
          this.#pendingUser = user;
          reject(new NewPasswordRequiredError());
        },
      });
    });
  }

  /** Answers the `NEW_PASSWORD_REQUIRED` challenge raised by `signIn`. */
  completeNewPassword(newPassword: string): Promise<AuthUser> {
    const user = this.#pendingUser;
    if (!user) {
      return Promise.reject(
        new AuthError('NoPendingChallenge', 'There is no password change in progress.'),
      );
    }
    return new Promise<AuthUser>((resolve, reject) => {
      user.completeNewPasswordChallenge(
        newPassword,
        {},
        {
          onSuccess: (session) => {
            this.#session = session;
            this.#user = user;
            this.#pendingUser = undefined;
            const current = this.currentUser;
            if (!current) {
              reject(new AuthError('NoIdToken', 'Cognito returned no ID token.'));
              return;
            }
            resolve(current);
          },
          onFailure: (error) => {
            const { code, message } = messageFor(error);
            reject(new AuthError(code, message));
          },
        },
      );
    });
  }

  /**
   * A currently-valid **ID token**, refreshing it if it is close to expiry.
   *
   * Returns `undefined` rather than throwing when nobody is signed in: the
   * transport passes it straight through, and an absent header produces the
   * API's own 401, which is the honest answer and keeps one code path for
   * "not signed in" instead of two.
   */
  async getIdToken(): Promise<string | undefined> {
    if (!this.#session) return undefined;

    const expiresAtMs = this.#session.getIdToken().getExpiration() * 1000;
    if (this.#session.isValid() && expiresAtMs - Date.now() > REFRESH_MARGIN_MS) {
      return this.#session.getIdToken().getJwtToken();
    }

    const user = this.#user;
    const refreshToken = this.#session.getRefreshToken();
    if (!user || !refreshToken) return undefined;

    try {
      const refreshed = await new Promise<CognitoUserSession>((resolve, reject) => {
        user.refreshSession(refreshToken, (error, session) => {
          if (error || !session) reject(error ?? new Error('no session'));
          else resolve(session);
        });
      });
      this.#session = refreshed;
      return refreshed.getIdToken().getJwtToken();
    } catch {
      // The refresh token is gone or revoked. Drop the session so the UI shows
      // the sign-in boundary rather than retrying a dead token forever.
      this.signOut();
      return undefined;
    }
  }

  signOut(): void {
    this.#user?.signOut();
    this.#session = undefined;
    this.#user = undefined;
    this.#pendingUser = undefined;
    this.#storage.clear();
  }
}
