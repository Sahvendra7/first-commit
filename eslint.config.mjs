import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Handover lint configuration.
 *
 * The load-bearing block is `domain-purity` below. See docs/architecture.md §14:
 * "The domain/ boundary is enforced, not suggested."
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/cdk.out/**',
      '**/coverage/**',
      'eval/golden-set/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    name: 'handover/base',
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  /**
   * The service worker is a classic worker script, not a module, and it runs
   * in a scope the browser provides: `self`, `caches`, `fetch`, `Response`,
   * `URL`. Flat config ignores `/* eslint-env *\/` comments, so the globals
   * are declared here instead — otherwise every one of them is `no-undef`.
   */
  /*
   * Build-time scripts under `apps/web/scripts/` run in Node, not the browser,
   * so they get Node's globals. Same reason as the service-worker block below:
   * flat config ignores `/* eslint-env *\/` comments.
   */
  {
    name: 'handover/build-scripts',
    files: ['apps/web/scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
      },
    },
  },

  {
    name: 'handover/service-worker',
    files: ['apps/web/public/sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        self: 'readonly',
        caches: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        URL: 'readonly',
        Promise: 'readonly',
      },
    },
  },

  /**
   * domain-purity — architecture.md §14 and §19.
   *
   * apps/api/src/domain/ is the modular-monolith core: state machine, evidence
   * pairing, diff merge, and the claim arithmetic. It must stay unit-testable
   * with zero AWS mocking, which means it must not reach for an SDK. All AWS
   * access lives in apps/api/src/adapters/ and is passed in as a port.
   *
   * Uses the typescript-eslint extension of `no-restricted-imports` (identical
   * options to the core rule) because the core rule does not see `import type`,
   * and a type-only `@aws-sdk/*` import still couples the domain to the SDK.
   */
  {
    name: 'handover/domain-purity',
    files: ['apps/api/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@aws-sdk',
                '@aws-sdk/*',
                'aws-sdk',
                'aws-cdk-lib',
                'aws-cdk-lib/*',
                'aws-lambda',
                '@aws-lambda-powertools/*',
                '@types/aws-lambda',
              ],
              message:
                'domain/ must contain no AWS imports (architecture.md §14). Put the AWS call in apps/api/src/adapters/ and pass a port into the domain function.',
            },
            {
              group: ['**/adapters/*', '**/adapters/**', '**/handlers/*', '**/handlers/**'],
              message:
                'domain/ must not depend on adapters/ or handlers/. Dependencies point inward only.',
            },
          ],
        },
      ],
    },
  },

  {
    name: 'handover/infra',
    files: ['infra/**/*.ts'],
    rules: {
      // CDK constructs are instantiated for their side effects.
      'no-new': 'off',
    },
  },
);
