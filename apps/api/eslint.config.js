import baseConfig from 'eslint-config-alexandernanberg/base'
import drizzlePlugin from 'eslint-plugin-drizzle'
import {defineConfig} from'eslint/config

export default defineConfig([
  ...baseConfig,
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      drizzle: drizzlePlugin,
    },
    rules: {
      'drizzle/enforce-update-with-where': [
        'error',
        { drizzleObjectName: ['db', 'tx'] },
      ],
      'drizzle/enforce-delete-with-where': [
        'error',
        { drizzleObjectName: ['db', 'tx'] },
      ],
    },
  },
])
