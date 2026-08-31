import { log } from 'evlog'
import { app } from '~/app'
import { assertConfigIsValid, config } from '~/config'
import { client, upgradeDatabase } from '~/db'
import { emailClient } from '~/lib/email'
import { redis } from '~/lib/redis'
import { listenForShutdownSignals, onShutdown } from '~/lib/shutdown'
import { startCleanupJob } from '~/services/cleanup'

// Before anything opens a socket. A misconfigured deploy should fail here, with
// the full list of what is wrong, rather than at the first request that happens
// to touch a bad value.
assertConfigIsValid()

if (config.MIGRATE_ON_START) {
  log.info('server', 'Running database migrations')
  await upgradeDatabase()
}

const server = Bun.serve({
  port: config.PORT,
  fetch: app.fetch,
})

const stopCleanupJob = startCleanupJob()

// Registration order is teardown order. The server goes first: `stop()` stops
// accepting connections and resolves once the requests already in flight have
// answered, so everything below is still open while they finish.
onShutdown('http server', () => server.stop())
onShutdown('cleanup job', () => stopCleanupJob())
onShutdown('database pool', () => client.end())
onShutdown('redis', () => redis.quit())
onShutdown('smtp transport', () => emailClient.close())

listenForShutdownSignals()

log.info('server', `Server running on ${server.url}`)
