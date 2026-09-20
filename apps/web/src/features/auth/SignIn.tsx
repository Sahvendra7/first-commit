import { useCallback, useState } from 'react';
import {
  NewPasswordRequiredError,
  type CognitoAuth,
  type AuthUser,
} from '../../lib/auth/cognito-auth.js';
import { toUserFacingError } from '../../lib/errors.js';

/**
 * The auth boundary — architecture.md §10.2.
 *
 * Email and password, straight into the SRP exchange. The password is held in
 * component state for exactly as long as the form is open and is never stored,
 * logged, or put in a URL; under SRP it is never transmitted either.
 *
 * ── Four modes, one form ────────────────────────────────────────────────────
 *
 * `SIGN_IN`   the ordinary path
 * `SIGN_UP`   registration. The pool has `selfSignUpEnabled`, so without this
 *             screen nobody who was not provisioned by hand can use the app at
 *             all — the account simply cannot be created.
 * `CONFIRM`   the six-digit code Cognito emails, because `autoVerify.email` is
 *             on and a registration is unusable until it is answered
 * `NEW_PASSWORD` a pool-created user's forced change on first sign-in
 *
 * They share one form because they share one pair of fields, and because a
 * separate route per mode would put an email address in a URL.
 */
export interface SignInProps {
  readonly auth: CognitoAuth;
  readonly onSignedIn: (user: AuthUser) => void;
}

type Mode = 'SIGN_IN' | 'SIGN_UP' | 'CONFIRM' | 'NEW_PASSWORD';

/** Mirrors the deployed pool's policy, so the rule is stated before it is hit. */
const PASSWORD_HINT =
  'At least 12 characters, with an uppercase letter, a lowercase letter and a digit.';

export function SignIn({ auth, onSignedIn }: SignInProps) {
  const [mode, setMode] = useState<Mode>('SIGN_IN');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const switchTo = useCallback((next: Mode) => {
    setMode(next);
    setError(undefined);
    setNotice(undefined);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      if (mode === 'SIGN_UP') {
        const { confirmed } = await auth.signUp(email, password);
        // A pool with `autoVerify.email` returns unconfirmed and emails a code.
        // Honouring `confirmed` rather than assuming it keeps this correct if
        // the pool's verification settings ever change.
        if (confirmed) {
          const user = await auth.signIn(email, password);
          setPassword('');
          onSignedIn(user);
          return;
        }
        setPassword('');
        setMode('CONFIRM');
        setNotice(`We sent a six-digit code to ${email}. Enter it to finish setting up.`);
        return;
      }

      if (mode === 'CONFIRM') {
        await auth.confirmSignUp(email, code.trim());
        setCode('');
        setMode('SIGN_IN');
        setNotice('Your account is verified. Sign in to continue.');
        return;
      }

      const user =
        mode === 'NEW_PASSWORD'
          ? await auth.completeNewPassword(newPassword)
          : await auth.signIn(email, password);
      setPassword('');
      setNewPassword('');
      onSignedIn(user);
    } catch (caught) {
      if (caught instanceof NewPasswordRequiredError) {
        setMode('NEW_PASSWORD');
        setError(caught.message);
      } else {
        const failure = toUserFacingError(caught);
        setError(failure.detail);
        // An unconfirmed account is the one failure with an obvious next step,
        // so it moves the form there instead of leaving a dead end.
        if (/not been verified/i.test(failure.detail)) setMode('CONFIRM');
      }
    } finally {
      setBusy(false);
    }
  }

  const resend = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await auth.resendConfirmationCode(email);
      setNotice(`We sent a new code to ${email}.`);
    } catch (caught) {
      setError(toUserFacingError(caught).detail);
    } finally {
      setBusy(false);
    }
  }, [auth, email]);

  const heading =
    mode === 'SIGN_UP'
      ? 'Create an account'
      : mode === 'CONFIRM'
        ? 'Check your email'
        : mode === 'NEW_PASSWORD'
          ? 'Choose a new password'
          : 'Sign in';

  const submitLabel = busy
    ? 'Working…'
    : mode === 'SIGN_UP'
      ? 'Create account'
      : mode === 'CONFIRM'
        ? 'Verify and continue'
        : mode === 'NEW_PASSWORD'
          ? 'Set password and sign in'
          : 'Sign in';

  return (
    <form onSubmit={submit} className="rounded-2xl bg-white p-6 shadow-sm border border-gray-100 space-y-4" data-testid="sign-in">
      <div>
        <h1 className="text-xl font-bold text-[#1a1a1a]">{heading}</h1>
        <p className="text-sm text-gray-500 mt-1">
          {mode === 'CONFIRM'
            ? 'Enter the six-digit code we emailed you.'
            : 'Your photographs are private to your account. Signing in is what ties the record to you.'}
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="auth-email">
          Email
        </label>
        <input
          id="auth-email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          // The address is fixed once a challenge is in progress: changing it
          // mid-flow would answer one account's challenge with another's code.
          disabled={mode === 'NEW_PASSWORD' || mode === 'CONFIRM'}
          className="min-h-11 w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-[#1a1a1a] placeholder:text-gray-400 focus:border-transparent focus:ring-2 focus:ring-[#1a1a1a] outline-none transition-all disabled:opacity-50 disabled:bg-gray-50"
        />
      </div>

      {mode === 'NEW_PASSWORD' ? (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="auth-new-password">
            Choose a new password
          </label>
          <input
            id="auth-new-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            aria-describedby="auth-password-hint"
            className="min-h-11 w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-[#1a1a1a] placeholder:text-gray-400 focus:border-transparent focus:ring-2 focus:ring-[#1a1a1a] outline-none transition-all"
          />
          <p id="auth-password-hint" className="text-xs text-gray-500 mt-1.5">
            {PASSWORD_HINT}
          </p>
        </div>
      ) : mode === 'CONFIRM' ? (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="auth-code">
            Verification code
          </label>
          <input
            id="auth-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="min-h-11 w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-[#1a1a1a] placeholder:text-gray-400 focus:border-transparent focus:ring-2 focus:ring-[#1a1a1a] outline-none transition-all tracking-widest"
          />
        </div>
      ) : (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="auth-password">
            Password
          </label>
          <input
            id="auth-password"
            type="password"
            autoComplete={mode === 'SIGN_UP' ? 'new-password' : 'current-password'}
            required
            {...(mode === 'SIGN_UP' ? { minLength: 12 } : {})}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            {...(mode === 'SIGN_UP' ? { 'aria-describedby': 'auth-password-hint' } : {})}
            className="min-h-11 w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-[#1a1a1a] placeholder:text-gray-400 focus:border-transparent focus:ring-2 focus:ring-[#1a1a1a] outline-none transition-all"
          />
          {mode === 'SIGN_UP' ? (
            <p id="auth-password-hint" className="text-xs text-gray-500 mt-1.5">
              {PASSWORD_HINT}
            </p>
          ) : null}
        </div>
      )}

      {error ? (
        <p role="alert" className="rounded-xl bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        data-testid="auth-submit"
        className="w-full rounded-xl bg-[#1a1a1a] px-4 py-3.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors disabled:opacity-50 min-h-11 mt-2"
      >
        {submitLabel}
      </button>

      {mode === 'SIGN_IN' ? (
        <p className="text-center text-sm text-gray-500 pt-2">
          No account yet?{' '}
          <button
            type="button"
            onClick={() => switchTo('SIGN_UP')}
            data-testid="to-sign-up"
            className="min-h-11 text-sm text-gray-500 hover:text-[#1a1a1a] transition-colors underline cursor-pointer"
          >
            Create one
          </button>
        </p>
      ) : null}

      {mode === 'SIGN_UP' ? (
        <p className="text-center text-sm text-gray-500 pt-2">
          Already have an account?{' '}
          <button
            type="button"
            onClick={() => switchTo('SIGN_IN')}
            data-testid="to-sign-in"
            className="min-h-11 text-sm text-gray-500 hover:text-[#1a1a1a] transition-colors underline cursor-pointer"
          >
            Sign in
          </button>
        </p>
      ) : null}

      {mode === 'CONFIRM' ? (
        <p className="text-center text-sm text-gray-500 pt-2">
          Didn&rsquo;t get it?{' '}
          <button
            type="button"
            onClick={() => void resend()}
            disabled={busy}
            data-testid="resend-code"
            className="min-h-11 text-sm text-gray-500 hover:text-[#1a1a1a] transition-colors underline cursor-pointer disabled:opacity-50 disabled:hover:text-gray-500"
          >
            Send a new code
          </button>
        </p>
      ) : null}
    </form>
  );
}
