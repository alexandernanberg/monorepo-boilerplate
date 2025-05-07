import { $ } from 'bun'
import { afterAll } from 'bun:test'
import { client, upgradeDatabase } from '~/db'
import { redis } from '~/lib/redis'

console.log('Starting containers...')
await $`docker compose -f ../../docker-compose.test.yml -p test up -d`.quiet()

console.log('Waiting for Redis to be available...')
await waitFor(() => redis.ping())

console.log('Waiting for PostgreSQL to be available...')
await waitFor(() => client.query('SELECT 1'))

console.log('Running database migrations...')
await upgradeDatabase()

afterAll(async () => {
  await redis.quit()
  await client.end()
  await $`docker compose -p test down`.quiet()
})

async function waitFor(cb: () => Promise<unknown>) {
  const maxRetries = 10
  const delay = 500
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await cb()
      return
    } catch {
      if (attempt === maxRetries) {
        throw new Error('Container is not ready after multiple attempts.')
      }
      await new Promise((res) => setTimeout(res, delay))
    }
  }
}
