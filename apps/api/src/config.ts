import { z } from 'zod'

export const env = z
  .enum(['production', 'development', 'test'])
  .default('development')
  .parse(process.env.NODE_ENV)

/**
 * Problems found while reading the environment, collected instead of thrown on
 * the spot so a misconfigured deploy reports everything that is wrong at once
 * rather than one variable per restart.
 *
 * Keyed by variable name: a field re-declared in a subclass is read twice, once
 * against the base class' default and once for real, and only the second read
 * describes what is actually wrong.
 */
const problems = new Map<string, string>()

const nonEmptyString = z.string().min(1)
const portNumber = z.coerce.number().int().min(1).max(65_535)
const positiveInt = z.coerce.number().int().positive()
const booleanFlag = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')

/**
 * Read and validate one environment variable.
 *
 * With a `fallback` the variable is optional — that is how the development
 * defaults below are written. Without one it is required, which is how
 * `ProductionConfig` states "this has to come from the environment".
 *
 * A failed read records the problem and returns as if it had succeeded. The lie
 * is contained: `config` is constructed and immediately checked below, so the
 * process is already on its way out before anything can read the value.
 */
function fromEnv<Schema extends z.ZodType>(
  name: string,
  schema: Schema,
  ...fallback: [] | [z.output<Schema>]
): z.output<Schema> {
  const raw = process.env[name]

  // An empty variable counts as unset. Platforms that inject every key they
  // know about, set or not, would otherwise be indistinguishable from a typo.
  if (raw === undefined || raw === '') {
    if (fallback.length === 1) {
      return fallback[0]
    }

    problems.set(name, `${name} is missing`)
    return undefined as z.output<Schema>
  }

  const result = schema.safeParse(raw)

  if (!result.success) {
    // Only the issue messages — never `raw`, which is a secret often enough.
    problems.set(
      name,
      `${name} is invalid: ${result.error.issues.map((issue) => issue.message).join(', ')}`,
    )
    return undefined as z.output<Schema>
  }

  return result.data
}

/**
 * Development defaults, matching the `docker-compose.yml` stack. Every one of
 * them can be overridden from the environment — Bun loads `.env` on its own, so
 * copying `.env.example` is enough. See `ProductionConfig` for the ones that
 * lose their default in production.
 */
class Config {
  PORT = fromEnv('PORT', portNumber, 4000)

  DATABASE_URL = fromEnv(
    'DATABASE_URL',
    nonEmptyString,
    'postgres://postgres:postgres@localhost:5432/workout',
  )

  EMAIL_SENDER = fromEnv('EMAIL_SENDER', nonEmptyString, 'noreply@acme.inc')

  SMTP_HOST = fromEnv('SMTP_HOST', nonEmptyString, 'localhost')
  SMTP_TLS = fromEnv('SMTP_TLS', booleanFlag, false)
  SMTP_PORT = fromEnv('SMTP_PORT', portNumber, 1025)
  SMTP_USER = fromEnv('SMTP_USER', nonEmptyString, '')
  SMTP_PASSWORD = fromEnv('SMTP_PASSWORD', nonEmptyString, '')

  REDIS_HOST = fromEnv('REDIS_HOST', nonEmptyString, 'localhost')
  REDIS_USER = fromEnv('REDIS_USER', nonEmptyString, '')
  REDIS_PASSWORD = fromEnv('REDIS_PASSWORD', nonEmptyString, '')
  REDIS_PORT = fromEnv('REDIS_PORT', portNumber, 6379)

  SESSION_TTL_DAYS = fromEnv('SESSION_TTL_DAYS', positiveInt, 30)
  SESSION_LAST_ACTIVE_THRESHOLD_MINUTES = fromEnv(
    'SESSION_LAST_ACTIVE_THRESHOLD_MINUTES',
    positiveInt,
    10,
  )

  SIGNUP_CODE_TTL_MINUTES = fromEnv('SIGNUP_CODE_TTL_MINUTES', positiveInt, 15)
  LOGIN_CODE_TTL_MINUTES = fromEnv('LOGIN_CODE_TTL_MINUTES', positiveInt, 15)

  MAX_FAILED_EMAIL_LOGIN_ATTEMPTS = fromEnv(
    'MAX_FAILED_EMAIL_LOGIN_ATTEMPTS',
    positiveInt,
    3,
  )
  MAX_FAILED_SIGNUP_ATTEMPTS = fromEnv(
    'MAX_FAILED_SIGNUP_ATTEMPTS',
    positiveInt,
    3,
  )

  RATE_LIMIT_IP_BUCKET_SIZE = fromEnv(
    'RATE_LIMIT_IP_BUCKET_SIZE',
    positiveInt,
    10,
  )
  RATE_LIMIT_IP_BUCKET_REFILL_RATE_SECONDS = fromEnv(
    'RATE_LIMIT_IP_BUCKET_REFILL_RATE_SECONDS',
    positiveInt,
    1,
  )

  // How long in-flight work gets to finish after a SIGTERM. Must stay below
  // the platform's own grace period, or it is SIGKILL that ends the process.
  SHUTDOWN_TIMEOUT_SECONDS = fromEnv(
    'SHUTDOWN_TIMEOUT_SECONDS',
    positiveInt,
    10,
  )
}

/**
 * Everything that names or authenticates against another system is read from
 * the environment with no fallback, so a missing variable stops the process at
 * boot instead of silently pointing production at localhost.
 */
class ProductionConfig extends Config {
  DATABASE_URL = fromEnv('DATABASE_URL', nonEmptyString)

  EMAIL_SENDER = fromEnv('EMAIL_SENDER', nonEmptyString)

  SMTP_HOST = fromEnv('SMTP_HOST', nonEmptyString)
  SMTP_TLS = fromEnv('SMTP_TLS', booleanFlag, true)
  SMTP_PORT = fromEnv('SMTP_PORT', portNumber, 587)
  SMTP_USER = fromEnv('SMTP_USER', nonEmptyString)
  SMTP_PASSWORD = fromEnv('SMTP_PASSWORD', nonEmptyString)

  REDIS_HOST = fromEnv('REDIS_HOST', nonEmptyString)
  // Required rather than defaulted: an unauthenticated Redis reachable from
  // production is a mistake worth failing on. Give it a fallback if the
  // instance really is only reachable over a private network.
  REDIS_PASSWORD = fromEnv('REDIS_PASSWORD', nonEmptyString)
}

/**
 * Pinned to the `docker-compose.test.yml` stack, and deliberately written as
 * literals rather than `fromEnv` reads: the suite truncates every table and
 * flushes Redis between tests, so a `DATABASE_URL` left in a developer's shell
 * or `.env` would aim `resetDatabase()` at their development data.
 */
class TestConfig extends Config {
  DATABASE_URL = 'postgres://postgres:postgres@localhost:5433/workout'

  SMTP_HOST = 'localhost'
  SMTP_PORT = 1026

  REDIS_HOST = 'localhost'
  REDIS_PORT = 6380
}

const config = new {
  development: Config,
  production: ProductionConfig,
  test: TestConfig,
}[env]()

if (problems.size > 0) {
  throw new Error(
    [
      `Invalid configuration for NODE_ENV=${env}:`,
      ...[...problems.values()].map((problem) => `  - ${problem}`),
      '',
      'See apps/api/.env.example for what each variable is.',
    ].join('\n'),
  )
}

export { config }
