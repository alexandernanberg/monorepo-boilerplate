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
      // Seeds and build scripts are one-shot programs run by a developer; their
      // output is the point.
      files: ['seed/**', 'scripts/**'],
      rules: {
        'no-console': 'off',
      },
    },
  ],
})
