import { log } from 'evlog'
import { app } from '~/app'

const server = Bun.serve({
  port: 4000,
  fetch: app.fetch,
})

log.info('server', `Server running on ${server.url}`)
