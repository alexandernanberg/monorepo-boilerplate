import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema.ts',
  dialect: 'postgresql',
  out: 'migrations',
  casing: 'snake_case',
  dbCredentials: {
    url:
      process.env['DATABASE_URL'] ??
      'postgres://postgres:postgres@localhost:5432/app',
  },
})
