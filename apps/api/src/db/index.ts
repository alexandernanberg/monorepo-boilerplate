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

// Arbitrary, but has to be the same for every replica.
const MIGRATION_LOCK_ID = 7_283_104_551

/**
 * Every replica runs this on boot. Drizzle's migrator takes no lock, so two
 * replicas starting together both read the same "last applied" row and both
 * apply what is pending — a failed boot at best, a data migration run twice at
 * worst. A Postgres advisory lock makes the rest wait their turn, after which
 * there is nothing left for them to do.
 */
async function upgradeDatabase() {
  const lock = await client.connect()
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID])
    await migrate(db, {
      migrationsFolder: path.resolve(process.cwd(), 'migrations'),
    })
  } finally {
    // Destroy rather than return the connection: ending the session releases
    // its advisory lock, migration failed or not, and keeps a connection that
    // still holds it out of the pool.
    lock.release(true)
  }
}

export { client, db, upgradeDatabase }
