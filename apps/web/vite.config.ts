import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  /**
   * `amazon-cognito-identity-js` still reaches for the Node `global`, which no
   * browser defines. Without this the bundle throws "global is not defined" at
   * module evaluation and the whole page renders blank — a failure jsdom cannot
   * reproduce, because jsdom provides `global`. Found in real Chromium.
   */
  define: { global: 'globalThis' },
  // Frontend runs against deployed dev infrastructure — no LocalStack (§13.2).
  test: {
    // Components in this app are drag-, canvas- and file-input-driven; the
    // logic that matters cannot be exercised without a DOM.
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
