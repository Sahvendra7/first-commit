/**
 * Service-worker registration.
 *
 * Kept out of `main.tsx` so the conditions under which a worker is installed
 * are a readable unit with a test, rather than three inlined `if`s at module
 * scope.
 *
 * Two of those conditions are load-bearing:
 *
 * - **Never in development.** Vite serves modules unbundled and unhashed; a
 *   cache-first worker in front of that serves yesterday's code and the
 *   resulting "my edit did nothing" is very expensive to diagnose.
 *
 * - **Never in demo mode.** `?demo=1` is a fixture walkthrough. Installing a
 *   worker from it would leave a shell cached on a device that never had a real
 *   session, and the next visit would boot the app from a cache seeded by a
 *   demo. The demo is meant to be isolated from production, and that includes
 *   not leaving anything behind.
 */

export interface RegisterOptions {
  /** Defaults to `import.meta.env.PROD`. */
  readonly enabled?: boolean;
  /** Defaults to `?demo=1` detection on the current URL. */
  readonly demo?: boolean;
  readonly container?: ServiceWorkerContainer | undefined;
  readonly search?: string;
}

/** True when a worker should be installed. Exported for the test. */
export function shouldRegister(options: RegisterOptions = {}): boolean {
  const search = options.search ?? globalThis.location?.search ?? '';
  const demo = options.demo ?? new URLSearchParams(search).get('demo') === '1';
  const enabled = options.enabled ?? Boolean(import.meta.env?.PROD);
  return enabled && !demo;
}

/**
 * Installs the worker, or does nothing. Never throws: a browser that refuses
 * to register one (private mode, an insecure origin, a blocked worker) still
 * has a completely functional app, so a failure here is logged and dropped
 * rather than surfaced.
 */
export function registerServiceWorker(options: RegisterOptions = {}): void {
  const container = options.container ?? globalThis.navigator?.serviceWorker;
  if (!container || !shouldRegister(options)) return;

  // Deferred to `load` so registration never competes with the first paint on
  // the phone this is used on.
  const register = (): void => {
    void container.register('/sw.js').catch(() => {
      /* An app that cannot cache its shell is still an app. */
    });
  };

  if (globalThis.document?.readyState === 'complete') register();
  else globalThis.addEventListener?.('load', register, { once: true });
}

/**
 * Removes any previously installed worker and its caches.
 *
 * Called in demo mode, because a device that once ran the real app and then
 * opens the demo must not keep a worker alive that the demo never asked for.
 */
export function unregisterServiceWorker(
  container: ServiceWorkerContainer | undefined = globalThis.navigator?.serviceWorker,
): void {
  if (!container) return;
  void container
    .getRegistrations?.()
    .then((registrations) => registrations.forEach((registration) => void registration.unregister()))
    .catch(() => undefined);
}
