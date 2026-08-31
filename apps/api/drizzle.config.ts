import { defineConfig } from 'drizzle-kit'
import { config } from './src/config'

export default defineConfig({
  schema: './src/db/schema.ts',
  dialect: 'postgresql',
  out: 'migrations',
  casing: 'snake_case',
  // Read from config rather than hardcoded, so `db:generate` and `db:push` can
  // target whatever `DATABASE_URL` / `NODE_ENV` say — a hardcoded development
  // URL means the only database these commands can ever reach is the local one.
  dbCredentials: {
    url: config.DATABASE_URL,
  },
})
