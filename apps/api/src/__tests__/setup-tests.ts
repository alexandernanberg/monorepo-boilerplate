import { $ } from 'bun'
import { afterAll } from 'bun:test'
import { client, upgradeDatabase } from '~/db'
import { redis } from '~/lib/redis'

/**
 * Set when Postgres, Redis and Mailpit are already listening on the test ports
 * — a CI job using service containers, or a developer keeping the stack up
 * between runs rather than paying `compose up`/`down` on every `bun test`.
 */
const servicesAreExternal = Boolean(process.env['TEST_SERVICES_EXTERNAL'])

if (!servicesAreExternal) {
  console.log('Starting containers...')
  await $`docker compose -f ../../docker-compose.test.yml -p test up -d`.quiet()
}

console.log('Waiting for Redis to be available...')
await waitFor('Redis', () => redis.ping())

console.log('Waiting for PostgreSQL to be available...')
await waitFor('PostgreSQL', () => client.query('SELECT 1'))

console.log('Running database migrations...')
await upgradeDatabase()

afterAll(async () => {
  await redis.quit()
  await client.end()

  if (!servicesAreExternal) {
    await $`docker compose -p test down`.quiet()
  }
})

async function waitFor(label: string, cb: () => Promise<unknown>) {
  // Postgres initdb can take a while after `up -d` returns.
  const maxRetries = 60
  const delay = 500
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await cb()
      return
    } catch (error) {
      if (attempt === maxRetries) {
        throw new Error(`${label} is not ready after ${maxRetries} attempts.`, {
          cause: error,
        })
      }
      await new Promise((res) => {
        setTimeout(res, delay)
      })
    }
  }
}
