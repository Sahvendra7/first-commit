import { useCallback, useEffect, useMemo, useState } from 'react';
import { createApiClient, isDemoMode, type HandoverApiClient } from './lib/api-client.js';
import { tryLoadConfig, type AppConfig } from './lib/config.js';
import { phaseOverrideFrom } from './lib/phase.js';
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
      {/* The product header. It names the app and says in one line what the app
          is for, so the first screen is never an unlabelled table of rooms. */}
      <header className="mb-4 border-b border-slate-200 pb-3">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-xl font-bold tracking-tight text-slate-900">Handover</h1>
          {demo ? (
            <span
              data-testid="demo-badge"
              className="shrink-0 rounded bg-fuchsia-100 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-fuchsia-900"
            >
              Demo
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-slate-600">
          Rental evidence, organized from move-in to deposit recovery.
        </p>
        {demo ? (
          <p className="mt-1 text-xs text-slate-500">
            Seeded walkthrough — not a real tenancy. Nothing here is sent anywhere.
          </p>
        ) : null}
      </header>

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
          <TenancyView
            api={api}
            tenancyId={tenancyId}
            {...(phaseOverride ? { phaseOverride } : {})}
            onSignOut={signOut}
          />
        </>
      )}
    </main>
  );
}
