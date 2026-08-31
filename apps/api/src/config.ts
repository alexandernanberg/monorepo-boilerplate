import { z } from 'zod'

/**
 * Read with a bracket, never `process.env.NODE_ENV`.
 *
 * Bun's bundler substitutes the *build-time* value for that exact dotted
 * expression — `--env=disable` does not cover it — so the built artifact gets
 * `parse("development")` baked in and the runtime `NODE_ENV` is ignored. That
 * silently turned off log redaction and JSON output, and dropped SMTP auth, in
 * every production image. `scripts/check-bundle.ts` fails the build if it comes
 * back.
 */
export const env = z
  .enum(['production', 'development', 'test'])
  .default('development')
  .parse(process.env['NODE_ENV'])

/**
 * Collected while the config object is constructed rather than thrown on the
 * spot, so a fresh deploy reports every missing or malformed variable at once
 * instead of one restart per mistake.
 */
const issues: Array<string> = []

/**
 * Read `name` from the environment and validate it.
 *
 * A `fallback` makes the variable optional — that is what lets `pnpm dev` work
 * with no `.env` at all. Omit it and the variable is required: an unset or
 * invalid value is recorded and surfaced by `assertConfigIsValid`.
 *
 * An empty string counts as unset. A platform that injects every known key,
 * set or not, would otherwise turn "not configured" into "configured as empty",
 * which is how you end up connecting to Postgres with a blank password.
 */
function read<T>(name: string, schema: z.ZodType<T>, fallback?: T): T {
  const raw = process.env[name]

  if (raw === undefined || raw === '') {
    if (fallback !== undefined) return fallback
    issues.push(`${name} is required but was not set`)
    // Never observed: `assertConfigIsValid` throws before the process serves
    // anything, and every caller reads config through the exported instance.
    return undefined as T
  }

  const result = schema.safeParse(raw)

  if (!result.success) {
    const reason = result.error.issues.map((issue) => issue.message).join('; ')
    issues.push(
      `${name} is invalid: ${reason} (received ${JSON.stringify(raw)})`,
    )
    return undefined as T
  }

  return result.data
}

const str = z.string().min(1)
const port = z.coerce.number().int().min(1).max(65_535)
const positiveInt = z.coerce.number().int().positive()
const bool = z.stringbool()
/** Comma-separated list, e.g. `CORS_ORIGINS=https://app.example,https://admin.example`. */
const list = z.string().transform((value) =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean),
)

class Config {
  PORT = read('PORT', port, 4000)

  DATABASE_URL = read(
    'DATABASE_URL',
    str,
    'postgres://postgres:postgres@localhost:5432/workout',
  )

  /**
   * Whether a proxy sits in front of the process and may be believed about the
   * client's address. Off by default: trusting `X-Forwarded-For` when nothing
   * strips it lets any client forge its own IP and walk past the rate limits.
   */
  TRUST_PROXY = read('TRUST_PROXY', bool, false)

  /** Empty means no CORS headers, which is correct for a same-origin or native client. */
  CORS_ORIGINS = read('CORS_ORIGINS', list, [] as Array<string>)

  /** Rejected before the body is read, so an oversized request costs nothing. */
  MAX_REQUEST_BODY_BYTES = read(
    'MAX_REQUEST_BODY_BYTES',
    positiveInt,
    64 * 1024,
  )

  EMAIL_SENDER = read('EMAIL_SENDER', str, 'noreply@acme.inc')

  SMTP_HOST = read('SMTP_HOST', str, 'localhost')
  SMTP_TLS = read('SMTP_TLS', bool, false)
  SMTP_PORT = read('SMTP_PORT', port, 1025)
  SMTP_USER = read('SMTP_USER', z.string(), '')
  SMTP_PASSWORD = read('SMTP_PASSWORD', z.string(), '')

  REDIS_HOST = read('REDIS_HOST', str, 'localhost')
  REDIS_USER = read('REDIS_USER', z.string(), '')
  REDIS_PASSWORD = read('REDIS_PASSWORD', z.string(), '')
  REDIS_PORT = read('REDIS_PORT', port, 6379)

  SESSION_TTL_DAYS = read('SESSION_TTL_DAYS', positiveInt, 30)
  SESSION_LAST_ACTIVE_THRESHOLD_MINUTES = read(
    'SESSION_LAST_ACTIVE_THRESHOLD_MINUTES',
    positiveInt,
    10,
  )

  SIGNUP_CODE_TTL_MINUTES = read('SIGNUP_CODE_TTL_MINUTES', positiveInt, 15)
  LOGIN_CODE_TTL_MINUTES = read('LOGIN_CODE_TTL_MINUTES', positiveInt, 15)

  MAX_FAILED_EMAIL_LOGIN_ATTEMPTS = read(
    'MAX_FAILED_EMAIL_LOGIN_ATTEMPTS',
    positiveInt,
    3,
  )
  MAX_FAILED_SIGNUP_ATTEMPTS = read(
    'MAX_FAILED_SIGNUP_ATTEMPTS',
    positiveInt,
    3,
  )

  RATE_LIMIT_IP_BUCKET_SIZE = read('RATE_LIMIT_IP_BUCKET_SIZE', positiveInt, 10)
  RATE_LIMIT_IP_BUCKET_REFILL_RATE_SECONDS = read(
    'RATE_LIMIT_IP_BUCKET_REFILL_RATE_SECONDS',
    positiveInt,
    1,
  )

  /**
   * Serves the GraphiQL IDE and schema introspection. Off in production by
   * default — publishing the schema hands an attacker the map.
   */
  GRAPHIQL_ENABLED = read('GRAPHIQL_ENABLED', bool, true)

  /**
   * Caps how deeply a query may nest. Without it one recursive query through a
   * cyclic schema is a cheap way to exhaust the database pool.
   */
  GRAPHQL_MAX_DEPTH = read('GRAPHQL_MAX_DEPTH', positiveInt, 12)

  /** How often expired sessions and challenges are swept. 0 disables the sweeper. */
  CLEANUP_INTERVAL_MINUTES = read(
    'CLEANUP_INTERVAL_MINUTES',
    z.coerce.number().int().min(0),
    60,
  )

  /**
   * Run pending migrations during boot, before the server accepts traffic.
   * Off by default: with more than one instance they would race, and a release
   * command (see `fly.toml`) is the safer place. Handy for single-instance
   * deploys and for `docker compose up`.
   */
  MIGRATE_ON_START = read('MIGRATE_ON_START', bool, false)

  // How long in-flight work gets to finish after a SIGTERM. Must stay below
  // the platform's own grace period, or it is SIGKILL that ends the process.
  SHUTDOWN_TIMEOUT_SECONDS = read('SHUTDOWN_TIMEOUT_SECONDS', positiveInt, 10)
}

/**
 * Everything a production deploy must be told explicitly. Re-reading each
 * variable without a fallback turns the development default into a hard
 * failure, so a forgotten secret stops the boot instead of quietly pointing the
 * process at `localhost`.
 */
class ProductionConfig extends Config {
  DATABASE_URL = read('DATABASE_URL', str)

  EMAIL_SENDER = read('EMAIL_SENDER', str)

  SMTP_HOST = read('SMTP_HOST', str)
  SMTP_TLS = read('SMTP_TLS', bool, true)
  SMTP_PORT = read('SMTP_PORT', port)
  SMTP_USER = read('SMTP_USER', str)
  SMTP_PASSWORD = read('SMTP_PASSWORD', str)

  REDIS_HOST = read('REDIS_HOST', str)
  REDIS_PORT = read('REDIS_PORT', port)

  GRAPHIQL_ENABLED = read('GRAPHIQL_ENABLED', bool, false)
}

class TestConfig extends Config {
  DATABASE_URL = read(
    'DATABASE_URL',
    str,
    'postgres://postgres:postgres@localhost:5433/workout',
  )

  SMTP_PORT = read('SMTP_PORT', port, 1026)

  REDIS_PORT = read('REDIS_PORT', port, 6380)

  // The sweeper's timer would keep the test runner alive.
  CLEANUP_INTERVAL_MINUTES = 0
}

const config = new {
  development: Config,
  production: ProductionConfig,
  test: TestConfig,
}[env]()

/**
 * Throw if anything was missing or malformed. Called from the entrypoints so
 * the process dies at boot with the whole list, rather than at the first
 * request that happens to touch a bad value.
 */
function assertConfigIsValid() {
  if (issues.length === 0) return

  throw new Error(
    `Invalid configuration for NODE_ENV=${env}:\n${issues
      .map((issue) => `  - ${issue}`)
      .join('\n')}`,
  )
}

export { assertConfigIsValid, config }
