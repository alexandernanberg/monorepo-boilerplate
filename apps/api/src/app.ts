import { evlog } from 'evlog/hono'
import { GraphQLError, NoSchemaIntrospectionCustomRule } from 'graphql'
import type { Plugin } from 'graphql-yoga'
import { createYoga } from 'graphql-yoga'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { csrf } from 'hono/csrf'
import { secureHeaders } from 'hono/secure-headers'
import { config } from '~/config'
import { createDataSources } from '~/graphql/data-loaders'
import { createMaxDepthRule } from '~/graphql/max-depth-rule'
import { schema } from '~/graphql/schema'
import type { EvlogVariables, Logger } from '~/lib/logger'
import { useLogger } from '~/lib/logger'
import { BucketRateLimiter } from '~/lib/rate-limiter'
import { NotFoundError, ServerError } from '~/lib/server-error'
import { getRequestIp } from '~/lib/utils'
import { authRouter } from '~/routes/auth'
import { getCurrentUser } from '~/services/user'

const app = new Hono<EvlogVariables>()

// Registered first so every downstream handler and `app.onError` can reach the
// request logger via `ctx.get('log')`. One wide event is emitted per request.
app.use(evlog())

const csrfProtection = csrf()

/**
 * Hono's `csrf()` substitutes `text/plain` for a missing `Content-Type`, and
 * `text/plain` is one of the types a browser form can post — so any request
 * without a content-type is treated as a form submission and rejected unless it
 * happens to carry a matching `Origin`.
 *
 * `POST /auth/logout` has no body, so a client sends no content-type and gets a
 * 403: logout fails while the client believes it succeeded, and the session
 * stays live. Only browsers were unaffected, because they send `Origin`.
 *
 * A request with neither a body nor a declared content-type cannot be a form
 * submission, so it is exempt; everything else is checked as before. Worth
 * noting that this API authenticates on the `Authorization` header rather than
 * a cookie, which is what actually makes CSRF a non-issue here — a cross-site
 * form cannot set that header. The middleware stays as defence in depth for
 * whenever cookies do appear.
 */
app.use(async (ctx, next) => {
  if (ctx.req.raw.body === null && !ctx.req.header('content-type')) {
    return await next()
  }

  return await csrfProtection(ctx, next)
})

app.use(secureHeaders())

// Only emit CORS headers when origins are actually configured. A same-origin or
// native client needs none, and `origin: '*'` on a credentialed API is worse
// than no CORS at all.
if (config.CORS_ORIGINS.length > 0) {
  app.use(
    cors({
      origin: config.CORS_ORIGINS,
      allowHeaders: ['authorization', 'content-type'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      maxAge: 600,
      credentials: true,
    }),
  )
}

// Checked against `Content-Length` before the body is read, so an oversized
// request is refused without buffering it. Every handler here reads a small
// JSON document; nothing legitimate comes close to the limit.
app.use(
  bodyLimit({
    maxSize: config.MAX_REQUEST_BODY_BYTES,
    onError: () => {
      throw new ServerError(
        413,
        'PAYLOAD_TOO_LARGE',
        'Request body is too large',
      )
    },
  }),
)

app.onError((error, ctx) => {
  const serverError = ServerError.from(error)
  logFailedRequest(ctx.get('log'), serverError, error)

  return serverError.toResponse()
})

app.get('/', (ctx) => ctx.text('OK'))
app.notFound(() => new NotFoundError().toResponse())

app.route('/auth', authRouter)

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

/**
 * Depth limiting bounds a single query; this bounds how many a caller may send.
 * Keyed by IP because that is what is known before the context — and therefore
 * before authentication — has run.
 */
const graphqlRateLimiter = new BucketRateLimiter('graphql_ip', {
  size: config.RATE_LIMIT_IP_BUCKET_SIZE * 10,
  refillRateSeconds: config.RATE_LIMIT_IP_BUCKET_REFILL_RATE_SECONDS,
})

/**
 * Bounds on what a single query may ask for, applied during validation so a
 * rejected query never reaches a resolver.
 */
const enforceQueryLimits: Plugin = {
  onValidate: ({ addValidationRule }) => {
    addValidationRule(createMaxDepthRule(config.GRAPHQL_MAX_DEPTH))

    // Introspection hands out the whole schema. It is also what makes GraphiQL
    // usable, so the two are deliberately tied to one switch.
    if (!config.GRAPHIQL_ENABLED) {
      addValidationRule(NoSchemaIntrospectionCustomRule)
    }
  },
}

const yoga = createYoga({
  schema,
  landingPage: false,
  // `landingPage: false` only replaces Yoga's 404 page — GraphiQL is a separate
  // switch and defaults to on, which publishes an interactive IDE in
  // production. Off unless explicitly enabled.
  graphiql: config.GRAPHIQL_ENABLED,
  // Yoga's own logger dumps errors straight to the console, unstructured and
  // detached from the request that caused them. `maskError` below puts them on
  // the request's wide event instead.
  logging: false,
  plugins: [logValidationErrors, enforceQueryLimits],
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

app.all('/graphql', async (ctx) => {
  await graphqlRateLimiter.consume(getRequestIp(ctx), 1)

  return yoga.handle(ctx.req.raw)
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
