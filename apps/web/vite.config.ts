import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // Frontend runs against deployed dev infrastructure — no LocalStack (§13.2).
  test: {
    // Components in this app are drag-, canvas- and file-input-driven; the
    // logic that matters cannot be exercised without a DOM.
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
