import type { AuditableLogger } from 'evlog'
import { initLogger } from 'evlog'
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

export type { EvlogVariables, Logger }
export { useLogger }
