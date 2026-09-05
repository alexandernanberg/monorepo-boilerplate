import { defineConfig } from 'oxlint'
import config from 'oxlint-config-alexandernanberg/oxlint/base'

export default defineConfig({
  extends: [config],

  ignorePatterns: ['migrations'],

  rules: {
    // Better Auth hooks (and similar adapters) are typed as `Promise<…>` with
    // nothing to await. Prefer `async` + `return` over `Promise.resolve()`.
    'typescript/require-await': 'off',
  },

  overrides: [
    {
      // Tests intentionally issue requests sequentially, e.g. to exhaust a
      // rate limit bucket one attempt at a time.
      files: ['**/__tests__/**', '**/*.test.ts'],
      rules: {
        'no-await-in-loop': 'off',
      },
    },
  ],
})
