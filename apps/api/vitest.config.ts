import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // No LocalStack (§13.2). AWS clients are mocked with aws-sdk-client-mock;
    // everything under src/domain/ is testable with no mocking at all.
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
