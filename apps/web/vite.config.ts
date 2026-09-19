import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // Frontend runs against deployed dev infrastructure — no LocalStack (§13.2).
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
