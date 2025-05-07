import { sha256 } from '@oslojs/crypto/sha2'
import { encodeHexLowerCase } from '@oslojs/encoding'
import { init } from '@paralleldrive/cuid2'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import ms from 'ms'
import { config } from '~/config'
import { db } from '~/db'
import type { Session } from '~/db/schema'
import { sessionsTable } from '~/db/schema'
import { ServerError } from '~/lib/server-error'

const createSessionToken = init({ length: 32 })

function createSessionTokenHash(token: string) {
  return encodeHexLowerCase(sha256(new TextEncoder().encode(token)))
}

async function createSession(
  token: string,
  userId: string,
  ipAddress: string,
  userAgent: string,
  tx?: Omit<typeof db, '$client'>,
) {
  const tokenHash = createSessionTokenHash(token)

  const session = await (tx ?? db)
    .insert(sessionsTable)
    .values({
      userId,
      tokenHash,
      ipAddress,
      userAgent,
      expiresAt: sql`now() + (${config.SESSION_TTL_DAYS} || 'days')::interval`,
    })
    .returning()
    .then((res) => res[0]!)

  return session
}

// TODO: when user verifies email or other significant actions, invalidate all
// active sessions and create a new session.
async function revokeAllActiveUserSesssions(userId: string) {
  await db
    .update(sessionsTable)
    .set({ revokedAt: sql`now()` })
    .where(
      and(eq(sessionsTable.userId, userId), isNull(sessionsTable.revokedAt)),
    )
}

async function revokeSession(sessionId: string) {
  await db
    .update(sessionsTable)
    .set({ revokedAt: sql`now()` })
    .where(eq(sessionsTable.id, sessionId))
}

function getSessionTokenFromRequest(req: Request) {
  const [, token] = (req.headers.get('authorization') ?? '').split(' ')
  return token ?? null
}

async function getSession(sessionToken: string | null) {
  if (!sessionToken) {
    throw new ServerError(401, 'UNAUTHORIZED', 'Missing authorization')
  }

  const tokenHash = createSessionTokenHash(sessionToken)

  const updatedSession = await db.transaction(async (tx) => {
    let session = await tx.query.sessionsTable.findFirst({
      where: eq(sessionsTable.tokenHash, tokenHash),
    })

    if (!session) {
      throw new ServerError(401, 'INVALID_SESSION', 'Invalid session')
    }

    if (session.revokedAt) {
      throw new ServerError(401, 'SESSION_REVOKED', 'Session revoked')
    }

    if (Date.now() >= session.expiresAt.getTime()) {
      throw new ServerError(401, 'SESSION_EXPIRED', 'Session has expired')
    }

    // Renew if the session is within the renewal window
    const renewalThreshold = new Date(
      Date.now() + ms(`${config.SESSION_TTL_DAYS / 2} days`),
    )
    const shouldRenewSession = session.expiresAt <= renewalThreshold

    // Check if lastActiveAt should be updated
    const minutesSinceLastActive =
      (Date.now() - session.lastActiveAt.getTime()) / (1000 * 60)
    const shouldUpdateLastActive =
      minutesSinceLastActive >= config.SESSION_LAST_ACTIVE_THRESHOLD_MINUTES

    if (shouldRenewSession || shouldUpdateLastActive) {
      const updates: PgUpdateSetSource<typeof sessionsTable> = {}
      if (shouldRenewSession) {
        updates.expiresAt = sql`now() + (${config.SESSION_TTL_DAYS} || 'days')::interval`
      }
      if (shouldUpdateLastActive) {
        updates.lastActiveAt = sql`now()`
      }

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      session! = await tx
        .update(sessionsTable)
        .set(updates)
        .where(eq(sessionsTable.id, session.id))
        .returning()
        .then((res) => res[0]!)
    }

    return session
  })

  return createSessionDto(updatedSession)
}

function createSessionDto(session: Session) {
  return {
    id: session.id,
    userId: session.userId,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    expiresAt: session.expiresAt,
    userAgent: session.userAgent,
    ipAddress: session.ipAddress,
  }
}

export {
  createSession,
  createSessionDto,
  createSessionToken,
  createSessionTokenHash,
  getSession,
  getSessionTokenFromRequest,
  revokeAllActiveUserSesssions,
  revokeSession,
}
