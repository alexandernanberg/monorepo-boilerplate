import { log } from 'evlog'
import { app } from '~/app'
import { config } from '~/config'
import { client } from '~/db'
import { emailClient } from '~/lib/email'
import { redis } from '~/lib/redis'
import { listenForShutdownSignals, onShutdown } from '~/lib/shutdown'

const server = Bun.serve({
  port: config.PORT,
  fetch: app.fetch,
})

// Registration order is teardown order. The server goes first: `stop()` stops
// accepting connections and resolves once the requests already in flight have
// answered, so everything below is still open while they finish.
onShutdown('http server', () => server.stop())
onShutdown('database pool', () => client.end())
onShutdown('redis', () => redis.quit())
onShutdown('smtp transport', () => emailClient.close())

listenForShutdownSignals()

log.info('server', `Server running on ${server.url}`)
