/**
 * The auth boundary — §10.2.
 *
 * The properties under test are mostly about what the form does *not* do: it
 * never keeps a password after a submit, never puts an address in a URL, and
 * never lets an email be edited while a challenge for a different address is
 * outstanding.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthError, NewPasswordRequiredError, type CognitoAuth } from '../../lib/auth/cognito-auth.js';
import { SignIn } from './SignIn.js';

afterEach(cleanup);

const USER = { email: 'tenant@example.com', sub: 'sub-1' };

function makeAuth(over: Partial<CognitoAuth> = {}): CognitoAuth {
  return {
    signIn: vi.fn().mockResolvedValue(USER),
    signUp: vi.fn().mockResolvedValue({ confirmed: false }),
    confirmSignUp: vi.fn().mockResolvedValue(undefined),
    resendConfirmationCode: vi.fn().mockResolvedValue(undefined),
    completeNewPassword: vi.fn().mockResolvedValue(USER),
    ...over,
  } as unknown as CognitoAuth;
}

function setValue(id: string, value: string): void {
  fireEvent.change(document.getElementById(id) as HTMLInputElement, { target: { value } });
}

function renderForm(auth: CognitoAuth, onSignedIn = vi.fn()) {
  render(<SignIn auth={auth} onSignedIn={onSignedIn} />);
  return { onSignedIn };
}

describe('SignIn — signing in', () => {
  it('signs in with the email and password entered', async () => {
    const signIn = vi.fn().mockResolvedValue(USER);
    const { onSignedIn } = renderForm(makeAuth({ signIn }));

    setValue('auth-email', 'tenant@example.com');
    setValue('auth-password', 'correct-horse-battery');
    fireEvent.click(screen.getByTestId('auth-submit'));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(USER));
    expect(signIn).toHaveBeenCalledWith('tenant@example.com', 'correct-horse-battery');
  });

  it('clears the password from the form once the submit resolves', async () => {
    const { onSignedIn } = renderForm(makeAuth());

    setValue('auth-email', 'tenant@example.com');
    setValue('auth-password', 'correct-horse-battery');
    fireEvent.click(screen.getByTestId('auth-submit'));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect((document.getElementById('auth-password') as HTMLInputElement | null)?.value ?? '').toBe(
      '',
    );
  });

  it('shows a failure without saying whether the account exists', async () => {
    const signIn = vi
      .fn()
      .mockRejectedValue(
        new AuthError('NotAuthorizedException', 'That email address and password do not match.'),
      );
    renderForm(makeAuth({ signIn }));

    setValue('auth-email', 'tenant@example.com');
    setValue('auth-password', 'wrong');
    fireEvent.click(screen.getByTestId('auth-submit'));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/do not match/i);
    expect(screen.getByRole('alert').textContent).not.toMatch(/no such user|not found/i);
  });

  it('re-enables the button after a failure so the tenant can try again', async () => {
    const signIn = vi.fn().mockRejectedValue(new AuthError('NotAuthorizedException', 'nope'));
    renderForm(makeAuth({ signIn }));

    setValue('auth-email', 'tenant@example.com');
    setValue('auth-password', 'wrong');
    fireEvent.click(screen.getByTestId('auth-submit'));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect((screen.getByTestId('auth-submit') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('SignIn — registering', () => {
  it('offers a way to create an account', () => {
    renderForm(makeAuth());
    expect(screen.getByTestId('to-sign-up')).toBeTruthy();
  });

  it('registers and then asks for the emailed code', async () => {
    const signUp = vi.fn().mockResolvedValue({ confirmed: false });
    renderForm(makeAuth({ signUp }));

    fireEvent.click(screen.getByTestId('to-sign-up'));
    setValue('auth-email', 'new@example.com');
    setValue('auth-password', 'correct-horse-battery-1A');
    fireEvent.click(screen.getByTestId('auth-submit'));

    // Addressed by role: "six-digit code" appears both in the standing
    // instruction and in the notice, so plain text matching finds two nodes.
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/six-digit code/i));
    expect(signUp).toHaveBeenCalledWith('new@example.com', 'correct-horse-battery-1A');
    expect(document.getElementById('auth-code')).toBeTruthy();
  });

  it('signs straight in when the pool returns an already-confirmed account', async () => {
    const signUp = vi.fn().mockResolvedValue({ confirmed: true });
    const signIn = vi.fn().mockResolvedValue(USER);
    const { onSignedIn } = renderForm(makeAuth({ signUp, signIn }));

    fireEvent.click(screen.getByTestId('to-sign-up'));
    setValue('auth-email', 'new@example.com');
    setValue('auth-password', 'correct-horse-battery-1A');
    fireEvent.click(screen.getByTestId('auth-submit'));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(USER));
  });

  it('reports a duplicate registration plainly', async () => {
    const signUp = vi
      .fn()
      .mockRejectedValue(
        new AuthError('UsernameExistsException', 'An account already exists for that email address.'),
      );
    renderForm(makeAuth({ signUp }));

    fireEvent.click(screen.getByTestId('to-sign-up'));
    setValue('auth-email', 'taken@example.com');
    setValue('auth-password', 'correct-horse-battery-1A');
    fireEvent.click(screen.getByTestId('auth-submit'));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/already exists/i);
  });

  it('states the pool password policy before it is hit', () => {
    renderForm(makeAuth());
    fireEvent.click(screen.getByTestId('to-sign-up'));

    expect(screen.getByText(/at least 12 characters/i)).toBeTruthy();
    expect((document.getElementById('auth-password') as HTMLInputElement).minLength).toBe(12);
  });

  it('can go back to signing in', () => {
    renderForm(makeAuth());
    fireEvent.click(screen.getByTestId('to-sign-up'));
    fireEvent.click(screen.getByTestId('to-sign-in'));

    expect(screen.getByRole('heading').textContent).toBe('Sign in');
  });
});

describe('SignIn — confirming', () => {
  it('confirms with the emailed code and returns to sign-in', async () => {
    const confirmSignUp = vi.fn().mockResolvedValue(undefined);
    renderForm(makeAuth({ confirmSignUp }));

    fireEvent.click(screen.getByTestId('to-sign-up'));
    setValue('auth-email', 'new@example.com');
    setValue('auth-password', 'correct-horse-battery-1A');
    fireEvent.click(screen.getByTestId('auth-submit'));
    await waitFor(() => expect(document.getElementById('auth-code')).toBeTruthy());

    setValue('auth-code', '123456');
    fireEvent.click(screen.getByTestId('auth-submit'));

    await waitFor(() => expect(confirmSignUp).toHaveBeenCalledWith('new@example.com', '123456'));
    await waitFor(() => expect(screen.getByText(/account is verified/i)).toBeTruthy());
  });

  it('locks the email address while a code for it is outstanding', async () => {
    renderForm(makeAuth());

    fireEvent.click(screen.getByTestId('to-sign-up'));
    setValue('auth-email', 'new@example.com');
    setValue('auth-password', 'correct-horse-battery-1A');
    fireEvent.click(screen.getByTestId('auth-submit'));

    await waitFor(() => expect(document.getElementById('auth-code')).toBeTruthy());
    expect((document.getElementById('auth-email') as HTMLInputElement).disabled).toBe(true);
  });

  it('can request a new code', async () => {
    const resendConfirmationCode = vi.fn().mockResolvedValue(undefined);
    renderForm(makeAuth({ resendConfirmationCode }));

    fireEvent.click(screen.getByTestId('to-sign-up'));
    setValue('auth-email', 'new@example.com');
    setValue('auth-password', 'correct-horse-battery-1A');
    fireEvent.click(screen.getByTestId('auth-submit'));
    await waitFor(() => expect(screen.getByTestId('resend-code')).toBeTruthy());

    fireEvent.click(screen.getByTestId('resend-code'));
    await waitFor(() =>
      expect(resendConfirmationCode).toHaveBeenCalledWith('new@example.com'),
    );
  });

  it('sends an unverified sign-in straight to the confirmation step', async () => {
    const signIn = vi
      .fn()
      .mockRejectedValue(
        new AuthError(
          'UserNotConfirmedException',
          'This account has not been verified yet. Check your email.',
        ),
      );
    renderForm(makeAuth({ signIn }));

    setValue('auth-email', 'unverified@example.com');
    setValue('auth-password', 'correct-horse-battery-1A');
    fireEvent.click(screen.getByTestId('auth-submit'));

    await waitFor(() => expect(document.getElementById('auth-code')).toBeTruthy());
  });
});

describe('SignIn — forced password change', () => {
  it('asks for a new password when Cognito demands one', async () => {
    const signIn = vi.fn().mockRejectedValue(new NewPasswordRequiredError());
    renderForm(makeAuth({ signIn }));

    setValue('auth-email', 'tenant@example.com');
    setValue('auth-password', 'temporary');
    fireEvent.click(screen.getByTestId('auth-submit'));

    await waitFor(() => expect(document.getElementById('auth-new-password')).toBeTruthy());
    expect((document.getElementById('auth-email') as HTMLInputElement).disabled).toBe(true);
  });

  it('completes the challenge and signs in', async () => {
    const signIn = vi.fn().mockRejectedValue(new NewPasswordRequiredError());
    const completeNewPassword = vi.fn().mockResolvedValue(USER);
    const { onSignedIn } = renderForm(makeAuth({ signIn, completeNewPassword }));

    setValue('auth-email', 'tenant@example.com');
    setValue('auth-password', 'temporary');
    fireEvent.click(screen.getByTestId('auth-submit'));
    await waitFor(() => expect(document.getElementById('auth-new-password')).toBeTruthy());

    setValue('auth-new-password', 'correct-horse-battery-1A');
    fireEvent.click(screen.getByTestId('auth-submit'));

    await waitFor(() => expect(completeNewPassword).toHaveBeenCalledWith('correct-horse-battery-1A'));
    expect(onSignedIn).toHaveBeenCalledWith(USER);
  });
});

describe('SignIn — nothing sensitive escapes', () => {
  it('never writes to browser storage', async () => {
    const { onSignedIn } = renderForm(makeAuth());

    setValue('auth-email', 'tenant@example.com');
    setValue('auth-password', 'correct-horse-battery');
    fireEvent.click(screen.getByTestId('auth-submit'));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());

    expect(globalThis.localStorage?.length ?? 0).toBe(0);
    expect(globalThis.sessionStorage?.length ?? 0).toBe(0);
  });

  it('keeps the password field a password field in every mode', () => {
    renderForm(makeAuth());
    expect((document.getElementById('auth-password') as HTMLInputElement).type).toBe('password');

    fireEvent.click(screen.getByTestId('to-sign-up'));
    expect((document.getElementById('auth-password') as HTMLInputElement).type).toBe('password');
  });
});
