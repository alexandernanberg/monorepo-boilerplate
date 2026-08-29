import { defineConfig } from 'oxfmt'
import config from 'oxlint-config-alexandernanberg/oxfmt/base'

export default defineConfig({
  ...config,
  ignorePatterns: ['**/migrations', '**/*.toml', 'pnpm-lock.yaml'],
})
