import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { log } from 'evlog'
import path from 'node:path'
import { Pool } from 'pg'
import { config, env } from '~/config'
import * as schema from './schema'

const client = new Pool({
  connectionString: config.DATABASE_URL,
  connectionTimeoutMillis: env === 'test' ? 1000 : undefined,
})

client.on('error', (error) => {
  log.error('database', error.message)
})

const db = drizzle({ client, schema, casing: 'snake_case' })

// Arbitrary but fixed: every replica must ask for the same lock.
const MIGRATION_LOCK_KEY = 7_432_115

/**
 * Apply pending migrations, serialized across processes.
 *
 * Replicas boot concurrently and Drizzle's migrator does not lock. Without one
 * they all see the same pending migration and race each other into "relation
 * already exists"; the losers crash and restart until the table exists. The
 * advisory lock is held on its own connection so the migrator's transaction
 * runs on another — session locks are per connection, so that is what makes it
 * a gate rather than a self-deadlock.
 */
async function upgradeDatabase() {
  const lock = await client.connect()
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
    try {
      await migrate(db, {
        migrationsFolder: path.resolve(process.cwd(), 'migrations'),
      })
    } finally {
      await lock.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
    }
  } finally {
    lock.release()
  }
}

export { client, db, upgradeDatabase }
