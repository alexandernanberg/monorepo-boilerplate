import { evlog } from 'evlog/hono'
import { GraphQLError } from 'graphql'
import { createYoga } from 'graphql-yoga'
import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { secureHeaders } from 'hono/secure-headers'
import { createDataSources } from '~/graphql/data-loaders'
import { schema } from '~/graphql/shema'
import type { EvlogVariables, Logger } from '~/lib/logger'
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
  logFailedRequest(ctx.get('log'), serverError, error)

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

      // Yoga swallows resolver errors into the GraphQL response, so without
      // this an exploding resolver leaves no trace anywhere.
      logFailedRequest(useLogger(), serverError, originalError ?? error)

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

/**
 * Record a failed request on its wide event.
 *
 * 5xx logs `error` rather than `serverError`, because `ServerError.from`
 * collapses anything it does not recognize into a generic 500 — logging the
 * mapped error throws away the message and stack of whatever actually broke.
 *
 * 4xx is an expected outcome (invalid code, rate limited, unauthorized), so the
 * event is marked as a warning carrying just the code and message. There is no
 * stack worth keeping, and a client mistake should not read as a server failure.
 */
function logFailedRequest(
  log: Logger,
  serverError: ServerError,
  error: unknown,
) {
  if (serverError.statusCode < 500) {
    log.setLevel('warn')
    log.set({
      error: { code: serverError.code, message: serverError.message },
    })
    return
  }

  log.error(error instanceof Error ? error : new Error(String(error)), {
    error: { code: serverError.code },
  })
}

export { app }
