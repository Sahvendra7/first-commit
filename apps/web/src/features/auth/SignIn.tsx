import { useState } from 'react';
import { NewPasswordRequiredError, type CognitoAuth, type AuthUser } from '../../lib/auth/cognito-auth.js';
import { toUserFacingError } from '../../lib/errors.js';

/**
 * The sign-in boundary — architecture.md §10.2.
 *
 * Email and password, straight into the SRP exchange. The password is held in
 * component state for exactly as long as the form is open and is never stored,
 * logged, or put in a URL; under SRP it is never transmitted either.
 *
 * `NEW_PASSWORD_REQUIRED` is handled because a pool-created user hits it on
 * first sign-in, and without this the account would simply be unusable with no
 * explanation.
 */
export interface SignInProps {
  readonly auth: CognitoAuth;
  readonly onSignedIn: (user: AuthUser) => void;
}

export function SignIn({ auth, onSignedIn }: SignInProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [needsNewPassword, setNeedsNewPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const user = needsNewPassword
        ? await auth.completeNewPassword(newPassword)
        : await auth.signIn(email, password);
      setPassword('');
      setNewPassword('');
      onSignedIn(user);
    } catch (caught) {
      if (caught instanceof NewPasswordRequiredError) {
        setNeedsNewPassword(true);
        setError(caught.message);
      } else {
        setError(toUserFacingError(caught).detail);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3" data-testid="sign-in">
      <h1 className="text-lg font-semibold text-slate-900">Sign in</h1>
      <p className="text-sm text-slate-600">
        Your photographs are private to your account. Signing in is what ties the record to
        you.
      </p>

      <label className="block text-xs font-medium text-slate-700">
        Email
        <input
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={needsNewPassword}
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
        />
      </label>

      {needsNewPassword ? (
        <label className="block text-xs font-medium text-slate-700">
          Choose a new password
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
          <span className="mt-1 block text-xs font-normal text-slate-500">
            At least 12 characters, with upper and lower case letters and a digit.
          </span>
        </label>
      ) : (
        <label className="block text-xs font-medium text-slate-700">
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
      )}

      {error ? (
        <p role="alert" className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-lg bg-slate-900 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
      >
        {busy ? 'Signing in…' : needsNewPassword ? 'Set password and sign in' : 'Sign in'}
      </button>
    </form>
  );
}
