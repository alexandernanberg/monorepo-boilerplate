import type { AuditableLogger } from 'evlog'
import { initLogger, log } from 'evlog'
import type { EvlogVariables } from 'evlog/hono'
import { useLogger } from 'evlog/hono'
import { env } from '~/config'

// Must run before `evlog()` is called in `~/app`, which is guaranteed as long
// as this module is imported there.
initLogger({
  env: {
    service: 'api',
    environment: env,
  },

  // Tree output locally, one JSON line per request in production.
  pretty: env === 'development',

  // Tests get the full pipeline with the console output muted. Note that
  // `enabled: false` is *not* interchangeable with this: it makes the
  // middleware skip, which leaves `ctx.get('log')` undefined and makes
  // `useLogger()` throw. The same applies to the middleware's `include` /
  // `exclude` route filters — anything that skips a request also removes its
  // logger. evlog warns at startup that nothing is draining these events,
  // which is accurate and only printed once.
  silent: env === 'test',

  // Scrubs emails, IPs, bearer tokens etc. from emitted events. This mirrors
  // evlog's own default, but the auth events carry enough PII that it is worth
  // stating explicitly. Flip it on in development to see what ships.
  redact: env === 'production',
})

/** The per-request logger, as returned by `ctx.get('log')` and `useLogger()`. */
type Logger = AuditableLogger

/**
 * `useLogger()` throws when there is no request ALS (startup, shutdown,
 * Better Auth internals). Prefer this at those boundaries.
 */
function tryUseLogger(): Logger | null {
  try {
    return useLogger()
  } catch {
    return null
  }
}

/**
 * Better Auth's default logger writes `[Better Auth]: …` to the console.
 * Same reason Yoga is `logging: false` — attach to the request event when
 * there is one, otherwise emit a tagged process log.
 */
const betterAuthLogger = {
  level: 'warn' as const,
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string) {
    const reqLog = tryUseLogger()
    switch (level) {
      case 'error':
        if (reqLog) {
          reqLog.error(message)
        } else {
          log.error('auth', message)
        }
        return
      case 'warn':
        if (reqLog) {
          reqLog.warn(message)
        } else {
          log.warn('auth', message)
        }
        return
      case 'debug':
        if (reqLog) {
          reqLog.info(message)
        } else {
          log.debug('auth', message)
        }
        return
      case 'info':
        if (reqLog) {
          reqLog.info(message)
        } else {
          log.info('auth', message)
        }
    }
  },
}

export type { EvlogVariables, Logger }
export { betterAuthLogger, tryUseLogger, useLogger }
