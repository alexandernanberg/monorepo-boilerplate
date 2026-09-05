import { z } from 'zod'

export const env = z
  .enum(['production', 'development', 'test'])
  .default('development')
  .parse(process.env.NODE_ENV)

function requiredEnv(name: string) {
  return z.string().min(1).parse(process.env[name])
}

class Config {
  DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/workout'

  EMAIL_SENDER = 'noreply@acme.inc'

  SMTP_HOST = 'localhost'
  SMTP_TLS = false
  SMTP_PORT = 1025
  SMTP_USER = ''
  SMTP_PASSWORD = ''

  REDIS_HOST = 'localhost'
  REDIS_USER = ''
  REDIS_PASSWORD = ''
  REDIS_PORT = 6379

  // Better Auth requires 32+ characters. Override in production via env.
  AUTH_SECRET = 'dev-only-secret-change-me-32chars!'
  AUTH_BASE_URL = 'http://localhost:4000'
  APP_ORIGIN = 'http://localhost:3000'

  SESSION_TTL_DAYS = 30
  OTP_TTL_MINUTES = 15
  OTP_LENGTH = 8
  OTP_MAX_ATTEMPTS = 3

  // How long in-flight work gets to finish after a SIGTERM. Must stay below
  // the platform's own grace period, or it is SIGKILL that ends the process.
  SHUTDOWN_TIMEOUT_SECONDS = 10

  get trustedOrigins() {
    return [this.APP_ORIGIN, 'http://localhost']
  }
}

class ProductionConfig extends Config {
  DATABASE_URL = requiredEnv('DATABASE_URL')

  EMAIL_SENDER = z.email().parse(process.env['EMAIL_SENDER'])

  SMTP_HOST = requiredEnv('SMTP_HOST')
  SMTP_TLS = process.env['SMTP_TLS'] === 'true'
  SMTP_PORT = z.coerce.number().parse(process.env['SMTP_PORT'] ?? '587')
  SMTP_USER = process.env['SMTP_USER'] ?? ''
  SMTP_PASSWORD = process.env['SMTP_PASSWORD'] ?? ''

  REDIS_HOST = requiredEnv('REDIS_HOST')
  REDIS_USER = process.env['REDIS_USER'] ?? ''
  REDIS_PASSWORD = process.env['REDIS_PASSWORD'] ?? ''
  REDIS_PORT = z.coerce.number().parse(process.env['REDIS_PORT'] ?? '6379')

  AUTH_SECRET = z.string().min(32).parse(process.env['BETTER_AUTH_SECRET'])
  AUTH_BASE_URL = z.url().parse(process.env['BETTER_AUTH_URL'])
  APP_ORIGIN = z.url().parse(process.env['APP_ORIGIN'])

  override get trustedOrigins() {
    return [this.APP_ORIGIN]
  }
}

class TestConfig extends Config {
  DATABASE_URL = 'postgres://postgres:postgres@localhost:5433/workout'

  SMTP_PORT = 1026

  REDIS_PORT = 6380
}

const config = new {
  development: Config,
  production: ProductionConfig,
  test: TestConfig,
}[env]()

export { config }
