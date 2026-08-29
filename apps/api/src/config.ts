import { z } from 'zod'

export const env = z
  .enum(['production', 'development', 'test'])
  .default('development')
  .parse(process.env.NODE_ENV)

class Config {
  DATABASE_URL = 'postgres://postgres:postgres@0.0.0.0:5432/workout'

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

  SESSION_TTL_DAYS = 30
  SESSION_LAST_ACTIVE_THRESHOLD_MINUTES = 10

  SIGNUP_CODE_TTL_MINUTES = 15
  LOGIN_CODE_TTL_MINUTES = 15

  MAX_FAILED_EMAIL_LOGIN_ATTEMPTS = 3
  MAX_FAILED_SIGNUP_ATTEMPTS = 3

  RATE_LIMIT_IP_BUCKET_SIZE = 10
  RATE_LIMIT_IP_BUCKET_REFILL_RATE_SECONDS = 1

  // How long in-flight work gets to finish after a SIGTERM. Must stay below
  // the platform's own grace period, or it is SIGKILL that ends the process.
  SHUTDOWN_TIMEOUT_SECONDS = 10
}

class ProductionConfig extends Config {
  // JWT_SECRET = z.string().min(32).parse(process.env.JWT_SECRET)
}

class TestConfig extends Config {
  DATABASE_URL = 'postgres://postgres:postgres@0.0.0.0:5433/workout'

  SMTP_PORT = 1026

  REDIS_PORT = 6380
}

const config = new {
  development: Config,
  production: ProductionConfig,
  test: TestConfig,
}[env]()

export { config }
