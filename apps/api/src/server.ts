import { app } from '~/app'

const server = Bun.serve({
  port: 4000,
  fetch: app.fetch,
})

console.log(`Server running on ${server.url}`)
