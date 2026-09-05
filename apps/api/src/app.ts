import { identifyUser } from 'evlog/better-auth'
import { evlog } from 'evlog/hono'
import { GraphQLError } from 'graphql'
import type { Plugin } from 'graphql-yoga'
import { createYoga } from 'graphql-yoga'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import { config, env } from '~/config'
import { client } from '~/db'
import { createDataSources } from '~/graphql/data-loaders'
import { schema } from '~/graphql/schema'
import { auth } from '~/lib/auth'
import type { EvlogVariables, Logger } from '~/lib/logger'
import { useLogger } from '~/lib/logger'
import { redis } from '~/lib/redis'
import { NotFoundError, ServerError } from '~/lib/server-error'
import {
  getCurrentUser,
  resolveSession,
  runWithCurrentUser,
} from '~/services/user'

const app = new Hono<EvlogVariables>()

// First so every downstream handler and `app.onError` can use `ctx.get('log')`.
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

app.onError((error, ctx) => {
  const serverError = ServerError.from(error)
  logFailedRequest(ctx.get('log'), serverError, error)

  return serverError.toResponse()
})

app.get('/', (ctx) => ctx.text('OK'))
app.get('/health', async (ctx) => {
  await Promise.all([client.query('SELECT 1'), redis.ping()])
  return ctx.text('OK')
})
app.notFound(() => new NotFoundError().toResponse())

app.all('/auth/*', async (c) => {
  const res = await auth.handler(c.req.raw)
  await logAuthResponse(c.get('log'), res)
  return res
})

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
  landingPage: env === 'development',
  // Errors go through `maskError` onto the request event, not Yoga's logger.
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
  context: ({ params }) => {
    // Every GraphQL request shares the `/graphql` path, so the operation name
    // is what makes the wide events tellable apart. Only sent by clients that
    // name their operations.
    if (params.operationName) {
      useLogger().set({ graphql: { operationName: params.operationName } })
    }

    const currentUser = getCurrentUser()

    return {
      dataSources: createDataSources(currentUser),
      currentUser,
    }
  },
})

app.use('/graphql', async (ctx) => {
  // Session is optional at the GraphQL layer: `viewer` is null when there
  // isn't one, and field resolvers decide what needs a user. Resolved once
  // here so Yoga's context reads it from AsyncLocalStorage.
  const session = await resolveSession(ctx.req.raw)
  if (session) {
    identifyUser(ctx.get('log'), session)
  }

  return runWithCurrentUser(session?.user ?? null, () =>
    yoga.handle(ctx.req.raw),
  )
})

/**
 * Better Auth answers 4xx/5xx itself, so they never reach `app.onError`.
 * Clone the body onto the wide event the same way thrown `ServerError`s are.
 */
async function logAuthResponse(log: Logger, res: Response) {
  if (res.status < 400) {
    return
  }

  const body: unknown = await res
    .clone()
    .json()
    .catch(() => null)
  const record = body !== null && typeof body === 'object' ? body : null
  const code =
    record && 'code' in record && typeof record.code === 'string'
      ? record.code
      : 'AUTH_ERROR'
  const message =
    record && 'message' in record && typeof record.message === 'string'
      ? record.message
      : res.statusText || 'Authentication error'

  if (res.status < 500) {
    log.setLevel('warn')
    log.set({ error: { code, message } })
    return
  }

  log.error(new Error(message), { error: { code } })
}

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
