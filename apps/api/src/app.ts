import { evlog } from 'evlog/hono'
import { GraphQLError } from 'graphql'
import { createYoga } from 'graphql-yoga'
import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { secureHeaders } from 'hono/secure-headers'
import { createDataSources } from '~/graphql/data-loaders'
import { schema } from '~/graphql/shema'
import type { EvlogVariables } from '~/lib/logger'
import { useLogger } from '~/lib/logger'
import { NotFoundError, ServerError } from '~/lib/server-error'
import { authRouter } from '~/routes/auth'
import { getCurrentUser } from '~/services/user'

const app = new Hono<EvlogVariables>()

// Registered first so every downstream handler and `app.onError` can reach the
// request logger via `ctx.get('log')`. One wide event is emitted per request.
app.use(evlog())

app.use(csrf())
app.use(secureHeaders())

app.onError((error, ctx) => {
  const serverError = ServerError.from(error)
  const log = ctx.get('log')

  if (serverError.statusCode >= 500) {
    // Log `error`, not `serverError`. `ServerError.from` collapses anything it
    // does not recognize into a generic 500, so logging the mapped error throws
    // away the message and stack of whatever actually broke.
    log.error(error, { error: { code: serverError.code } })
  } else {
    // Expected outcomes (invalid code, rate limited, unauthorized). Recorded on
    // the wide event so they are queryable, but not as errors.
    log.warn(serverError.message, { error: { code: serverError.code } })
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
      const originalError =
        error instanceof GraphQLError ? error.originalError : error
      const serverError = ServerError.from(originalError)
      const log = useLogger()

      // Yoga swallows resolver errors into the GraphQL response, so without
      // this an exploding resolver leaves no trace anywhere.
      if (serverError.statusCode >= 500) {
        log.error(
          originalError instanceof Error
            ? originalError
            : new Error(String(originalError ?? error)),
          { error: { code: serverError.code } },
        )
      } else {
        log.warn(serverError.message, { error: { code: serverError.code } })
      }

      return serverError.toGraphQLError()
    },
  },
  context: async ({ request, params }) => {
    // Every GraphQL request shares the `/graphql` path, so the operation name
    // is what makes the wide events tellable apart.
    useLogger().set({
      graphql: { operationName: params.operationName ?? null },
    })

    const currentUser = await getCurrentUser(request)
    const dataSources = createDataSources(currentUser)

    useLogger().set({ user: { id: currentUser.id } })

    return {
      dataSources,
      currentUser,
    }
  },
})

app.use('/graphql', async (ctx) => yoga.handle(ctx.req.raw))

export { app }
