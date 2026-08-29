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
