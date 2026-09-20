/**
 * Service-worker registration policy.
 *
 * The rules here are about what must *not* be installed. A worker registered
 * from `?demo=1` would leave a shell cached on a device that never had a real
 * session, which breaks the isolation the demo boundary exists to provide.
 */
import { describe, expect, it, vi } from 'vitest';
import { registerServiceWorker, shouldRegister, unregisterServiceWorker } from './register-sw.js';

function fakeContainer() {
  return {
    register: vi.fn().mockResolvedValue({}),
    getRegistrations: vi.fn().mockResolvedValue([]),
  } as unknown as ServiceWorkerContainer & {
    register: ReturnType<typeof vi.fn>;
    getRegistrations: ReturnType<typeof vi.fn>;
  };
}

describe('shouldRegister', () => {
  it('registers for a production build outside demo mode', () => {
    expect(shouldRegister({ enabled: true, search: '' })).toBe(true);
  });

  it('never registers in demo mode', () => {
    expect(shouldRegister({ enabled: true, search: '?demo=1' })).toBe(false);
  });

  it('never registers in development, even outside demo mode', () => {
    expect(shouldRegister({ enabled: false, search: '' })).toBe(false);
  });

  it('never registers in development in demo mode either', () => {
    expect(shouldRegister({ enabled: false, search: '?demo=1' })).toBe(false);
  });

  it('is not fooled by another query parameter', () => {
    expect(shouldRegister({ enabled: true, search: '?tenancy=ten_1' })).toBe(true);
  });

  it('treats demo=0 as not a demo', () => {
    expect(shouldRegister({ enabled: true, search: '?demo=0' })).toBe(true);
  });
});

describe('registerServiceWorker', () => {
  it('registers the worker at the app root scope', () => {
    const container = fakeContainer();
    registerServiceWorker({ enabled: true, demo: false, container });

    expect(container.register).toHaveBeenCalledWith('/sw.js');
  });

  it('registers nothing in demo mode', () => {
    const container = fakeContainer();
    registerServiceWorker({ enabled: true, demo: true, container });

    expect(container.register).not.toHaveBeenCalled();
  });

  it('registers nothing in development', () => {
    const container = fakeContainer();
    registerServiceWorker({ enabled: false, demo: false, container });

    expect(container.register).not.toHaveBeenCalled();
  });

  it('does not throw when the browser refuses to register', () => {
    const container = fakeContainer();
    container.register.mockRejectedValue(new Error('insecure origin'));

    expect(() =>
      registerServiceWorker({ enabled: true, demo: false, container }),
    ).not.toThrow();
  });

  it('does nothing at all when the browser has no service worker support', () => {
    expect(() =>
      registerServiceWorker({ enabled: true, demo: false, container: undefined }),
    ).not.toThrow();
  });
});

describe('unregisterServiceWorker', () => {
  it('removes every registration it finds', async () => {
    const unregister = vi.fn().mockResolvedValue(true);
    const container = fakeContainer();
    container.getRegistrations.mockResolvedValue([{ unregister }, { unregister }]);

    unregisterServiceWorker(container);
    await vi.waitFor(() => expect(unregister).toHaveBeenCalledTimes(2));
  });

  it('does not throw when there is no container', () => {
    expect(() => unregisterServiceWorker(undefined)).not.toThrow();
  });
});
