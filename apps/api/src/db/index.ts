import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { config, env } from '~/config'
import * as schema from './schema'

const client = new Pool({
  connectionString: config.DATABASE_URL,
  connectionTimeoutMillis: env === 'test' ? 0 : undefined,
})

const db = drizzle({ client, schema, casing: 'snake_case' })

/**
 * Where the SQL lives, relative to whatever is running.
 *
 * The app collapses into a single bundled file, so this module's location is
 * not fixed: `src/db/` from source, `apps/api/dist/` from a local build, and
 * `/app/` in the image. A single relative path can only be right for one of
 * them — the previous `../../migrations` resolved to `/migrations` inside the
 * container — so each is tried in turn.
 */
function migrationsFolder() {
  const here = path.dirname(fileURLToPath(import.meta.url))

  return [
    // src/db/index.ts
    path.resolve(here, '../../migrations'),
    // apps/api/dist/server.js
    path.resolve(here, '../migrations'),
    // /app/server.js, as copied by the Dockerfile
    path.resolve(here, './migrations'),
  ]
}

async function upgradeDatabase() {
  const { existsSync } = await import('node:fs')
  const folder = migrationsFolder().find((candidate) => existsSync(candidate))

  if (!folder) {
    throw new Error(
      `Could not find a migrations folder. Looked in:\n${migrationsFolder()
        .map((candidate) => `  - ${candidate}`)
        .join('\n')}`,
    )
  }

  await migrate(db, { migrationsFolder: folder })
}

export { client, db, upgradeDatabase }
