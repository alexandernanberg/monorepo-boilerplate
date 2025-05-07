import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import path from 'node:path'
import { Pool } from 'pg'
import { config, env } from '~/config'
import * as schema from './schema'

const client = new Pool({
  connectionString: config.DATABASE_URL,
  connectionTimeoutMillis: env === 'test' ? 0 : undefined,
})

const db = drizzle({ client, schema, casing: 'snake_case' })

async function upgradeDatabase() {
  await migrate(db, {
    migrationsFolder: path.resolve(__dirname, '../../migrations'),
  })
}

export { client, db, upgradeDatabase }
