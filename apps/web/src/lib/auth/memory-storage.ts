/**
 * In-memory token storage for `amazon-cognito-identity-js`.
 *
 * The library persists its session to `window.localStorage` by default. This
 * app stores nothing there — a deliberate constraint, and the right one for
 * this product: §10.2 pairs a one-hour ID token with Cognito-managed refresh
 * precisely so that "no tokens in localStorage" is survivable, and the assets
 * behind those tokens are photographs of people's homes and their addresses
 * (§10.1). A token in `localStorage` outlives the tab, survives a shared
 * device, and is readable by any injected script on the origin.
 *
 * So the session lives here, for the life of the page, and is gone on reload.
 */
export class MemoryStorage {
  readonly #entries = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#entries.get(key) ?? null;
  }

  setItem(key: string, value: string): string {
    this.#entries.set(key, value);
    return value;
  }

  removeItem(key: string): string {
    const previous = this.#entries.get(key) ?? '';
    this.#entries.delete(key);
    return previous;
  }

  clear(): void {
    this.#entries.clear();
  }

  /** Test affordance — the number of keys the library is holding. */
  get size(): number {
    return this.#entries.size;
  }
}
