import { lt, sql } from 'drizzle-orm'
import { log } from 'evlog'
import { config } from '~/config'
import { db } from '~/db'
import {
  emailChangeRequestsTable,
  loginChallengesTable,
  sessionsTable,
  signupChallengesTable,
} from '~/db/schema'

/**
 * Expired rows are dead weight: a session past `expiresAt` is rejected on
 * sight, and a spent challenge is never read again. Nothing deleted them, so
 * the tables grew for the life of the deployment — and the indexes with them.
 *
 * Each table is swept separately so one failure does not strand the others, and
 * every delete is bounded by the `expiresAt` index added alongside this.
 */
async function deleteExpiredRecords() {
  const expired = sql`now()`

  const [sessions, signupChallenges, loginChallenges, emailChangeRequests] =
    await Promise.all([
      db
        .delete(sessionsTable)
        .where(lt(sessionsTable.expiresAt, expired))
        .returning({ id: sessionsTable.id }),
      db
        .delete(signupChallengesTable)
        .where(lt(signupChallengesTable.expiresAt, expired))
        .returning({ id: signupChallengesTable.id }),
      db
        .delete(loginChallengesTable)
        .where(lt(loginChallengesTable.expiresAt, expired))
        .returning({ id: loginChallengesTable.id }),
      db
        .delete(emailChangeRequestsTable)
        .where(lt(emailChangeRequestsTable.expiresAt, expired))
        .returning({ id: emailChangeRequestsTable.id }),
    ])

  return {
    sessions: sessions.length,
    signupChallenges: signupChallenges.length,
    loginChallenges: loginChallenges.length,
    emailChangeRequests: emailChangeRequests.length,
  }
}

/**
 * Run `deleteExpiredRecords` on an interval, returning a function that stops it.
 *
 * The timer is `unref`'d so it never by itself keeps the process alive, and a
 * failed sweep is logged rather than thrown — an unhandled rejection from a
 * background timer would take the server down over rows that can just as well
 * be deleted an hour later.
 *
 * With more than one instance running they all sweep, which is harmless: the
 * deletes are idempotent and whoever gets there first simply deletes fewer rows.
 */
function startCleanupJob() {
  if (config.CLEANUP_INTERVAL_MINUTES === 0) {
    return () => {
      // Disabled; nothing to stop.
    }
  }

  let running = false

  const sweep = async () => {
    // Skip rather than queue: on a large backlog the sweep can outlast the
    // interval, and piling runs on top of each other only adds lock contention.
    if (running) return
    running = true

    try {
      const deleted = await deleteExpiredRecords()
      log.info({ action: 'cleanup', ...deleted })
    } catch (error) {
      log.error({
        action: 'cleanup',
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      running = false
    }
  }

  const timer = setInterval(
    () => void sweep(),
    config.CLEANUP_INTERVAL_MINUTES * 60 * 1000,
  )
  timer.unref()

  return () => clearInterval(timer)
}

export { deleteExpiredRecords, startCleanupJob }
