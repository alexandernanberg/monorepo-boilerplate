import { z } from 'zod'

export const env = z
  .enum(['production', 'development', 'test'])
  .default('development')
  .parse(process.env.NODE_ENV)

/**
 * Parse one environment variable, naming it in the error. Zod's own message
 * ("expected string, received undefined") does not say which variable is
 * missing, which is the only thing that matters when a container fails to boot.
 */
function parseEnv<T>(name: string, schema: z.ZodType<T>, fallback?: string) {
  const result = schema.safeParse(process.env[name] ?? fallback)
  if (!result.success) {
    const reason = result.error.issues[0]?.message ?? 'invalid value'
    throw new Error(`Invalid environment variable ${name}: ${reason}`)
  }
  return result.data
}

function requiredEnv(name: string) {
  return parseEnv(name, z.string({ error: 'required' }).min(1, 'required'))
}

class Config {
  DATABASE_URL =
    process.env['DATABASE_URL'] ??
    'postgres://postgres:postgres@localhost:5432/app'

  EMAIL_SENDER = process.env['EMAIL_SENDER'] ?? 'noreply@acme.inc'

  SMTP_HOST = process.env['SMTP_HOST'] ?? 'localhost'
  SMTP_TLS = process.env['SMTP_TLS'] === 'true'
  SMTP_PORT = parseEnv('SMTP_PORT', z.coerce.number().int().positive(), '1025')
  SMTP_USER = process.env['SMTP_USER'] ?? ''
  SMTP_PASSWORD = process.env['SMTP_PASSWORD'] ?? ''

  REDIS_URL = process.env['REDIS_URL'] ?? ''
  REDIS_HOST = process.env['REDIS_HOST'] ?? 'localhost'
  REDIS_USER = process.env['REDIS_USER'] ?? ''
  REDIS_PASSWORD = process.env['REDIS_PASSWORD'] ?? ''
  REDIS_PORT = parseEnv(
    'REDIS_PORT',
    z.coerce.number().int().positive(),
    '6379',
  )

  // Better Auth requires 32+ characters. Override in production via env.
  AUTH_SECRET =
    process.env['BETTER_AUTH_SECRET'] ?? 'dev-only-secret-change-me-32chars!'
  AUTH_BASE_URL = process.env['BETTER_AUTH_URL'] ?? 'http://localhost:4000'
  APP_ORIGIN = process.env['APP_ORIGIN'] ?? 'http://localhost:3000'

  SESSION_TTL_DAYS = 30
  OTP_TTL_MINUTES = 15
  OTP_LENGTH = 8
  OTP_MAX_ATTEMPTS = 3

  // Largest request body the server accepts. GraphQL queries and auth payloads
  // are a few KB; anything approaching this is a mistake or an attack.
  MAX_REQUEST_BODY_BYTES = 1024 * 1024

  // How long in-flight work gets to finish after a SIGTERM. Must stay below
  // the platform's own grace period, or it is SIGKILL that ends the process.
  SHUTDOWN_TIMEOUT_SECONDS = 10

  get trustedOrigins() {
    return [this.APP_ORIGIN, 'http://localhost']
  }
}

class ProductionConfig extends Config {
  DATABASE_URL = requiredEnv('DATABASE_URL')

  EMAIL_SENDER = parseEnv('EMAIL_SENDER', z.email())

  SMTP_HOST = requiredEnv('SMTP_HOST')
  // Opt out, not in: SMTP credentials should never cross the wire in the clear
  // by default. Set SMTP_TLS=false for a relay that is plaintext on purpose.
  SMTP_TLS = process.env['SMTP_TLS'] !== 'false'
  SMTP_PORT = parseEnv('SMTP_PORT', z.coerce.number().int().positive(), '587')
  SMTP_USER = process.env['SMTP_USER'] ?? ''
  SMTP_PASSWORD = process.env['SMTP_PASSWORD'] ?? ''

  REDIS_URL = process.env['REDIS_URL'] ?? ''
  REDIS_HOST = process.env['REDIS_URL']
    ? (process.env['REDIS_HOST'] ?? '')
    : requiredEnv('REDIS_HOST')
  REDIS_USER = process.env['REDIS_USER'] ?? ''
  REDIS_PASSWORD = process.env['REDIS_PASSWORD'] ?? ''
  REDIS_PORT = parseEnv(
    'REDIS_PORT',
    z.coerce.number().int().positive(),
    '6379',
  )

  AUTH_SECRET = parseEnv(
    'BETTER_AUTH_SECRET',
    z.string().min(32, 'must be at least 32 characters'),
  )
  AUTH_BASE_URL = parseEnv('BETTER_AUTH_URL', z.url())
  APP_ORIGIN = parseEnv('APP_ORIGIN', z.url())

  override get trustedOrigins() {
    return [this.APP_ORIGIN]
  }
}

class TestConfig extends Config {
  DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5433/app'

  SMTP_HOST = '127.0.0.1'
  SMTP_TLS = false
  SMTP_PORT = 1026
  SMTP_USER = ''
  SMTP_PASSWORD = ''

  REDIS_URL = ''
  REDIS_HOST = '127.0.0.1'
  REDIS_USER = ''
  REDIS_PASSWORD = ''
  REDIS_PORT = 6380
}

const config = new {
  development: Config,
  production: ProductionConfig,
  test: TestConfig,
}[env]()

export { config }
