import { GraphQLError } from 'graphql'
import { createYoga } from 'graphql-yoga'
import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import { createDataSources } from '~/graphql/data-loaders'
import { schema } from '~/graphql/shema'
import { NotFoundError, ServerError } from '~/lib/server-error'
import { authRouter } from '~/routes/auth'
import { getCurrentUser } from '~/services/user'
import { env } from './config'

const isTest = env === 'test'

const app = new Hono()

if (!isTest) {
  app.use(logger())
}

app.use(csrf())
app.use(secureHeaders())
app.onError((error) => {
  const serverError = ServerError.from(error)

  if (!isTest) {
    console.error(serverError.toJSON())
  }

  return serverError.toResponse()
})

app.get('/', (ctx) => ctx.text('OK'))
app.notFound(() => new NotFoundError().toResponse())

app.route('/auth', authRouter)

const yoga = createYoga({
  schema,
  landingPage: false,
  maskedErrors: {
    maskError: (error) => {
      return ServerError.from(
        error instanceof GraphQLError ? error.originalError : error,
      ).toGraphQLError()
    },
  },
  context: async ({ request }) => {
    const currentUser = await getCurrentUser(request)
    const dataSources = createDataSources(currentUser)

    return {
      dataSources,
      currentUser,
    }
  },
})

app.use('/graphql', async (ctx) => yoga.handle(ctx.req.raw))

export { app }
