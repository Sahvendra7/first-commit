import { useCallback, useEffect, useMemo, useState } from 'react';
import { createApiClient, isDemoMode, type HandoverApiClient } from './lib/api-client.js';
import { tryLoadConfig, type AppConfig } from './lib/config.js';
import { phaseOverrideFrom } from './lib/phase.js';
import { CognitoAuth, type AuthUser } from './lib/auth/cognito-auth.js';
import { DEMO_TENANCY_ID } from './lib/demo/index.js';
import { SignIn } from './features/auth/SignIn.js';
import { Landing } from './features/landing/Landing.js';
import { CreateTenancy } from './features/tenancy/CreateTenancy.js';
import { TenancyView } from './features/tenancy/TenancyView.js';
import { AppShell, Banner, Button, Section } from './ui/index.js';

/**
 * Application shell: configuration, the auth boundary, and which screen is on.
 *
 * Demo mode short-circuits both gates — it needs no backend and no account,
 * which is the entire point of it (web-contract §8). Production mode needs
 * both, and never borrows from the demo when either is missing: a fixture
 * shown to a real tenant would be fabricated evidence.
 *
 * The tenancy id lives in the query string. There is no `localStorage` in this
 * app, and §7 defines no list endpoint, so a tenancy is reached by id or it is
 * created.
 *
 * ── Why there is now a landing screen in front of all of it ─────────────────
 *
 * Both entry paths used to open on a screen written for someone who already
 * knew what the product was: `?demo=1` went straight to a condition summary,
 * production went straight to a password field. The landing is the answer to
 * "what is this?", and it is skipped for anyone past that question — a URL
 * carrying a `tenancy`, or a signed-in session with a record to make.
 */
export function App() {
  const demo = isDemoMode();
  const configResult = useMemo(() => tryLoadConfig(), []);
  const config: AppConfig | undefined = configResult.ok ? configResult.config : undefined;

  // One auth instance for the life of the page. The session lives in memory
  // inside it and is gone on reload, by design.
  //
  // Not constructed in demo mode, and not merely unused there: demo mode must
  // work with no backend and no account at all, so it must not depend on a
  // Cognito pool being configured or reachable.
  const auth = useMemo(
    () => (!demo && config ? new CognitoAuth(config) : undefined),
    [demo, config],
  );

  const [user, setUser] = useState<AuthUser>();
  const [api, setApi] = useState<HandoverApiClient>();
  const [tenancyId, setTenancyId] = useState<string | undefined>(() => {
    // Unlike before, demo mode does not default to the seeded id: the landing
    // is the demo's front door too, and its CTA is what opens the record.
    return new URLSearchParams(globalThis.location?.search ?? '').get('tenancy') ?? undefined;
  });
  /** False until the visitor has asked to go past the landing screen. */
  const [entered, setEntered] = useState(false);

  /*
   * Only an explicit override. The phase itself is derived from the tenancy's
   * own status inside `TenancyView`, which is the component that has the
   * record — defaulting to MOVEOUT here filed a new tenancy's move-in
   * photographs as move-out evidence.
   */
  const phaseOverride = useMemo(
    () => phaseOverrideFrom(globalThis.location?.search ?? ''),
    [],
  );

  // The client is built once demo mode or a signed-in session makes it usable.
  useEffect(() => {
    let cancelled = false;
    if (!demo && (!config || !user || !auth)) {
      setApi(undefined);
      return;
    }
    void createApiClient({
      demo,
      ...(config ? { baseUrl: config.apiBaseUrl } : {}),
      ...(auth ? { getIdToken: () => auth.getIdToken() } : {}),
    }).then((client) => {
      if (!cancelled) setApi(client);
    });
    return () => {
      cancelled = true;
    };
  }, [auth, config, demo, user]);

  const signOut = useCallback(() => {
    auth?.signOut();
    setUser(undefined);
    setApi(undefined);
    setEntered(false);
  }, [auth]);

  const selectTenancy = useCallback((id: string) => {
    setTenancyId(id);
    // Keep the id in the URL so a reload returns to the same record — the only
    // place it is kept, since this app uses no localStorage.
    const url = new URL(globalThis.location.href);
    url.searchParams.set('tenancy', id);
    globalThis.history?.replaceState(null, '', url);
  }, []);

  const barActions = demo ? (
    <a
      href="/"
      className="rounded-lg px-2 py-1.5 text-sm font-medium text-ink-2 underline-offset-4 hover:bg-paper-deep hover:underline"
    >
      Leave demo
    </a>
  ) : user ? (
    <>
      <span className="hidden max-w-[16ch] truncate text-ink-3 sm:inline" data-testid="signed-in-as">
        {user.email}
      </span>
      <Button tone="quiet" size="sm" onClick={signOut}>
        Sign out
      </Button>
    </>
  ) : null;

  /* ── The landing screen, and what its buttons do here ──────────────────── */

  const showLanding = !tenancyId && !entered && (demo || !user);

  if (showLanding) {
    return (
      <AppShell width="full" demo={demo} barActions={barActions}>
        <Landing
          demo={demo}
          {...(demo
            ? {
                primaryLabel: 'Open the demo record',
                onPrimary: () => selectTenancy(DEMO_TENANCY_ID),
                // Leaving the demo lives in the app bar. The hero's second
                // button should take someone further in, not out.
                secondaryLabel: 'How it works',
                secondaryHref: '#how-it-works',
              }
            : configResult.ok
              ? {
                  primaryLabel: 'Start a record',
                  onPrimary: () => setEntered(true),
                  secondaryLabel: 'Explore the demo',
                  secondaryHref: '?demo=1',
                }
              : {
                  // Nothing to start against, so the demo becomes the primary
                  // path and the reason is stated rather than implied.
                  primaryLabel: 'Explore the demo',
                  onPrimary: () => {
                    globalThis.location.assign('?demo=1');
                  },
                  notice: <NotConfigured missing={configResult.ok ? [] : configResult.error.missing} />,
                })}
        />
      </AppShell>
    );
  }

  /* ── Past the landing ─────────────────────────────────────────────────── */

  if (!demo && !configResult.ok) {
    return (
      <AppShell width="measure">
        <NotConfigured missing={configResult.error.missing} onPaper />
      </AppShell>
    );
  }

  if (!demo && !user) {
    return (
      <AppShell width="measure" barActions={barActions}>
        {auth ? <SignIn auth={auth} onSignedIn={setUser} /> : null}
      </AppShell>
    );
  }

  if (!api) {
    return (
      <AppShell width="measure" demo={demo} barActions={barActions}>
        <p className="text-sm text-ink-2">Connecting…</p>
      </AppShell>
    );
  }

  if (!tenancyId) {
    return (
      <AppShell width="measure" demo={demo} barActions={barActions}>
        <CreateTenancy api={api} onCreated={(created) => selectTenancy(created.tenancyId)} />
      </AppShell>
    );
  }

  return (
    <AppShell width="record" demo={demo} barActions={barActions}>
      <TenancyView
        api={api}
        tenancyId={tenancyId}
        {...(phaseOverride ? { phaseOverride } : {})}
        onSignOut={signOut}
      />
    </AppShell>
  );
}

/**
 * Configuration is checked before anything else: without it there is no
 * backend to talk to, and a blank screen with a console error is the worst
 * possible way to say so.
 */
function NotConfigured({
  missing,
  onPaper,
}: {
  readonly missing: readonly string[];
  readonly onPaper?: boolean;
}) {
  const body = (
    <>
      <p>
        This build has no backend configured, so it cannot sign you in or load a record. Copy{' '}
        <code className="font-mono">.env.example</code> to{' '}
        <code className="font-mono">.env.local</code> and set:
      </p>
      <ul className="mt-1.5 list-inside list-disc">
        {missing.map((key) => (
          <li key={key}>
            <code className="font-mono">{key}</code>
          </li>
        ))}
      </ul>
    </>
  );

  return onPaper ? (
    <Section
      headingLevel={1}
      eyebrow="Setup"
      title="Not configured"
      headingId="not-configured-heading"
      data-testid="not-configured"
    >
      <div className="text-sm text-ink-2">{body}</div>
      <p className="mt-3 text-sm text-ink-2">
        Or append <code className="font-mono">?demo=1</code> to see the seeded offline
        walkthrough.
      </p>
    </Section>
  ) : (
    <Banner
      role="status"
      tone="warn"
      title="Not configured"
      data-testid="not-configured"
      className="!bg-white/10 !border-white/20 !border-l-warn [&_*]:!text-white/75 [&_strong]:!text-white"
    >
      {body}
    </Banner>
  );
}
