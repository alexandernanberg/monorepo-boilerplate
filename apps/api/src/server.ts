import { log } from 'evlog'
import { app } from '~/app'

const server = Bun.serve({
  port: Number(process.env.PORT) || 4000,
  fetch: app.fetch,
})

log.info('server', `Server running on ${server.url}`)
