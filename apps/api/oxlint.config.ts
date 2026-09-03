import { defineConfig } from 'oxlint'
import config from 'oxlint-config-alexandernanberg/oxlint/base'

export default defineConfig({
  extends: [config],

  ignorePatterns: ['migrations'],

  overrides: [
    {
      // Tests intentionally issue requests sequentially, e.g. to exhaust a
      // rate limit bucket one attempt at a time.
      files: ['**/__tests__/**', '**/*.test.ts'],
      rules: {
        'no-await-in-loop': 'off',

        // Bun refuses `.only` when CI=true and errors out the whole file, so a
        // leftover focused test fails CI rather than quietly narrowing the run.
        // oxlint's jest/vitest plugin only recognises test functions imported
        // from `vitest`/`@jest/globals`, not `bun:test`, so match by name here.
        'no-restricted-properties': [
          'error',
          ...['describe', 'test', 'it'].map((object) => ({
            object,
            property: 'only',
            message: 'Remove the focused test before committing.',
          })),
        ],
      },
    },
    {
      // Placeholder that is filled in per project.
      files: ['seed/**'],
      rules: {
        'unicorn/no-empty-file': 'off',
      },
    },
  ],
})
