import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Phase } from '@handover/shared';
import { createApiClient, isDemoMode, type HandoverApiClient } from './lib/api-client.js';
import { tryLoadConfig, type AppConfig } from './lib/config.js';
import { CognitoAuth, type AuthUser } from './lib/auth/cognito-auth.js';
import { DEMO_TENANCY_ID } from './lib/demo/index.js';
import { SignIn } from './features/auth/SignIn.js';
import { CreateTenancy } from './features/tenancy/CreateTenancy.js';
import { TenancyView } from './features/tenancy/TenancyView.js';

/**
 * Application shell: configuration, the auth boundary, and which tenancy is on
 * screen.
 *
 * Demo mode short-circuits both gates — it needs no backend and no account,
 * which is the entire point of it (web-contract §8). Production mode needs
 * both, and never borrows from the demo when either is missing: a fixture
 * shown to a real tenant would be fabricated evidence.
 *
 * The tenancy id lives in the query string. There is no `localStorage` in this
 * app, and §7 defines no list endpoint, so a tenancy is reached by id or it is
 * created.
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
    const fromQuery = new URLSearchParams(globalThis.location?.search ?? '').get('tenancy');
    return fromQuery ?? (isDemoMode() ? DEMO_TENANCY_ID : undefined);
  });

  const phase: Phase = useMemo(() => {
    const raw = new URLSearchParams(globalThis.location?.search ?? '').get('phase');
    return raw === 'MOVEIN' ? 'MOVEIN' : 'MOVEOUT';
  }, []);

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
  }, [auth]);

  const selectTenancy = useCallback((id: string) => {
    setTenancyId(id);
    // Keep the id in the URL so a reload returns to the same record — the only
    // place it is kept, since this app uses no localStorage.
    const url = new URL(globalThis.location.href);
    url.searchParams.set('tenancy', id);
    globalThis.history?.replaceState(null, '', url);
  }, []);

  return (
    <main className="mx-auto min-h-screen w-full max-w-screen-sm px-4 py-6">
      {demo ? (
        <p
          data-testid="demo-badge"
          className="mb-3 rounded bg-fuchsia-100 px-2 py-1 text-center text-xs font-semibold uppercase tracking-wide text-fuchsia-900"
        >
          Demo data — not a real tenancy
        </p>
      ) : null}

      {/* Configuration is checked before anything else: without it there is no
          backend to talk to, and a blank screen with a console error is the
          worst possible way to say so. */}
      {!demo && !configResult.ok ? (
        <div className="space-y-2" data-testid="not-configured">
          <h1 className="text-lg font-semibold text-slate-900">Not configured</h1>
          <p className="text-sm text-slate-600">
            This build has no backend configured, so it cannot sign you in or load a
            tenancy. Copy <code>.env.example</code> to <code>.env.local</code> and set:
          </p>
          <ul className="list-inside list-disc text-sm text-slate-700">
            {configResult.error.missing.map((key) => (
              <li key={key}>
                <code>{key}</code>
              </li>
            ))}
          </ul>
          <p className="text-sm text-slate-600">
            Or append <code>?demo=1</code> to see the seeded offline walkthrough.
          </p>
        </div>
      ) : !demo && !user ? (
        auth ? <SignIn auth={auth} onSignedIn={setUser} /> : null
      ) : !api ? (
        <p className="text-sm text-slate-600">Connecting…</p>
      ) : !tenancyId ? (
        <CreateTenancy api={api} onCreated={(created) => selectTenancy(created.tenancyId)} />
      ) : (
        <>
          {!demo && user ? (
            <div className="mb-3 flex items-baseline justify-between gap-2 text-xs text-slate-500">
              <span className="truncate" data-testid="signed-in-as">
                {user.email}
              </span>
              <button type="button" onClick={signOut} className="underline">
                Sign out
              </button>
            </div>
          ) : null}
          <TenancyView api={api} tenancyId={tenancyId} phase={phase} onSignOut={signOut} />
        </>
      )}
    </main>
  );
}
