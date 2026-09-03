import { defineConfig } from 'drizzle-kit'
import { config } from './src/config'

export default defineConfig({
  schema: './src/db/schema.ts',
  dialect: 'postgresql',
  out: 'migrations',
  casing: 'snake_case',
  dbCredentials: {
    url: config.DATABASE_URL,
  },
})
