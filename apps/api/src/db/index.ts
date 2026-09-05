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

async function upgradeDatabase() {
  await migrate(db, {
    migrationsFolder: path.resolve(process.cwd(), 'migrations'),
  })
}

export { client, db, upgradeDatabase }
