import { evlog } from 'evlog/hono'
import { GraphQLError } from 'graphql'
import type { Plugin } from 'graphql-yoga'
import { createYoga } from 'graphql-yoga'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { csrf } from 'hono/csrf'
import { secureHeaders } from 'hono/secure-headers'
import { config } from '~/config'
import { createDataSources } from '~/graphql/data-loaders'
import { schema } from '~/graphql/schema'
import { auth } from '~/lib/auth'
import type { EvlogVariables, Logger } from '~/lib/logger'
import { useLogger } from '~/lib/logger'
import { NotFoundError, ServerError } from '~/lib/server-error'
import { getCurrentUser, runWithCurrentUser } from '~/services/user'

const app = new Hono<EvlogVariables>()

// Registered first so every downstream handler and `app.onError` can reach the
// request logger via `ctx.get('log')`. One wide event is emitted per request.
app.use(evlog())

app.use(secureHeaders())
app.use(
  cors({
    origin: config.trustedOrigins,
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['set-auth-token'],
  }),
)
// Bearer and Better Auth's own origin check cover `/auth`. CSRF is for
// cookie-authenticated browser calls to GraphQL.
app.use('/graphql', csrf())

app.onError((error, ctx) => {
  const serverError = ServerError.from(error)
  logFailedRequest(ctx.get('log'), serverError, error)

  return serverError.toResponse()
})

app.get('/', (ctx) => ctx.text('OK'))
app.notFound(() => new NotFoundError().toResponse())

app.all('/auth/*', (c) => auth.handler(c.req.raw))

/**
 * Validation failures never reach `maskError`, so without this a client sending
 * malformed queries is indistinguishable from a healthy one: the response
 * carries the errors but the request logs a clean 200.
 */
const logValidationErrors: Plugin = {
  onValidate: () => (payload) => {
    if (payload.valid) return

    const errors: ReadonlyArray<unknown> = payload.result
    const log = useLogger()

    log.setLevel('warn')
    log.set({
      error: {
        code: 'GRAPHQL_VALIDATION_FAILED',
        message: errors
          .map((validationError) =>
            validationError instanceof Error
              ? validationError.message
              : 'Unknown validation error',
          )
          .join('; '),
      },
    })
  },
}

const yoga = createYoga({
  schema,
  landingPage: false,
  // Yoga's own logger dumps errors straight to the console, unstructured and
  // detached from the request that caused them. `maskError` below puts them on
  // the request's wide event instead.
  logging: false,
  plugins: [logValidationErrors],
  maskedErrors: {
    maskError: (error) => {
      const log = useLogger()

      // Parse failures arrive as a `GraphQLError` with no `originalError`. They
      // describe the client's own query, expose nothing internal, and are what
      // the client needs in order to fix the request. Masking them to a generic
      // 500 makes a client mistake look like ours — and logs it as one.
      if (error instanceof GraphQLError && !error.originalError) {
        const code = error.extensions['code']

        log.setLevel('warn')
        log.set({
          error: {
            code: typeof code === 'string' ? code : 'GRAPHQL_ERROR',
            message: error.message,
          },
        })

        return error
      }

      const originalError =
        error instanceof GraphQLError ? error.originalError : error
      const serverError = ServerError.from(originalError)

      logFailedRequest(log, serverError, originalError ?? error)

      return serverError.toGraphQLError()
    },
  },
  context: async ({ request, params }) => {
    // Every GraphQL request shares the `/graphql` path, so the operation name
    // is what makes the wide events tellable apart. Only sent by clients that
    // name their operations.
    if (params.operationName) {
      useLogger().set({ graphql: { operationName: params.operationName } })
    }

    const currentUser = await getCurrentUser(request)
    const dataSources = createDataSources(currentUser)

    useLogger().set({ user: { id: currentUser.id } })

    return {
      dataSources,
      currentUser,
    }
  },
})

app.use('/graphql', async (ctx) => {
  // Resolve the session once in Hono so a missing token is a 401 JSON body
  // (via `app.onError`) rather than a GraphQL 200 with an errors array.
  // Yoga's context reads the same user from AsyncLocalStorage.
  const currentUser = await getCurrentUser(ctx.req.raw)
  return runWithCurrentUser(currentUser, () => yoga.handle(ctx.req.raw))
})

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
