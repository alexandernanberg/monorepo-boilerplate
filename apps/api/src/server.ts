import { app } from '~/app'

const server = Bun.serve({
  port: Number(process.env.PORT) || 4000,
  fetch: app.fetch,
})

console.log(`Server running on ${server.url}`)
