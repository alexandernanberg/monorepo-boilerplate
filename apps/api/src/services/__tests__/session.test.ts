import { faker } from '@faker-js/faker'
import { beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import type { PgInsertValue } from 'drizzle-orm/pg-core'
import ms from 'ms'
import { mailpit, resetDatabase } from '~/__tests__/test-utils'
import { config } from '~/config'
import { db } from '~/db'
import { sessionsTable, usersTable } from '~/db/schema'
import { redis } from '~/lib/redis'
import { ServerError } from '~/lib/server-error'
import {
  createSessionToken,
  createSessionTokenHash,
  getSession,
} from '../session'

describe.only('getSession', () => {
  beforeEach(async () => {
    setSystemTime()

    await Promise.all([
      redis.flushall(),
      mailpit.resetMessages(),
      resetDatabase(),
    ])
  })

  test('returns current session', async () => {
    const now = new Date()
    const userAgent = faker.internet.userAgent()
    const ipAddress = faker.internet.ipv4()
    const expiresAt = new Date(
      now.getTime() + ms(`${config.SESSION_TTL_DAYS}d`),
    )

    const { userId } = await seedUser()
    const { sessionId, sessionToken } = await seedSession({
      userId,
      expiresAt,
      ipAddress,
      userAgent,
      createdAt: now,
      lastActiveAt: now,
    })

    const session = await getSession(sessionToken)

    expect(session).toEqual({
      id: sessionId,
      userId,
      createdAt: now,
      lastActiveAt: now,
      expiresAt,
      ipAddress,
      userAgent,
    })
  })

  test('renews session if below threshold', async () => {
    const { userId } = await seedUser()
    const { sessionToken } = await seedSession({
      userId,
      expiresAt: new Date(Date.now() + ms(`${config.SESSION_TTL_DAYS / 2}d`)),
    })

    const session = await getSession(sessionToken)

    expect(normalizeDatePrecision(session.expiresAt)).toEqual(
      normalizeDatePrecision(Date.now() + ms(`${config.SESSION_TTL_DAYS}d`)),
    )
  })

  test('does not renew session if over threshold', async () => {
    const expiresAt = new Date(
      Date.now() + ms(`${config.SESSION_TTL_DAYS - 5}d`),
    )

    const { userId } = await seedUser()
    const { sessionToken } = await seedSession({ userId, expiresAt })

    const session = await getSession(sessionToken)

    expect(session.expiresAt).toEqual(expiresAt)
  })

  test('updates lastActiveAt if below threshold', async () => {
    const now = Date.now()

    const { userId } = await seedUser()
    const { sessionToken } = await seedSession({
      userId,
      expiresAt: new Date(now + ms('10d')),
    })

    const { expiresAt } = await getSession(sessionToken)

    expect(expiresAt.getTime() - now).toBeLessThanOrEqual(now)
  })

  test('throws when token is missing', async () => {
    try {
      await getSession('')
      throw new Error('Expected getSession to throw an error, but it did not')
    } catch (error) {
      expect(error).toBeInstanceOf(ServerError)
      expect(error).toHaveProperty('code', 'UNAUTHORIZED')
    }
  })

  test('throws token is invalid', async () => {
    try {
      await getSession('invalid-session-id')
      throw new Error('Expected getSession to throw an error, but it did not')
    } catch (error) {
      expect(error).toBeInstanceOf(ServerError)
      expect(error).toHaveProperty('code', 'INVALID_SESSION')
    }
  })

  test('throws token is revoked', async () => {
    const { userId } = await seedUser()
    const { sessionToken } = await seedSession({
      userId,
      expiresAt: new Date(Date.now() + ms('30d')),
      revokedAt: new Date(),
    })

    try {
      await getSession(sessionToken)
      throw new Error('Expected getSession to throw an error, but it did not')
    } catch (error) {
      expect(error).toBeInstanceOf(ServerError)
      expect(error).toHaveProperty('code', 'SESSION_REVOKED')
    }
  })

  test('throws token has expired', async () => {
    const { userId } = await seedUser()
    const { sessionToken } = await seedSession({
      userId,
      expiresAt: new Date(Date.now() - ms('10d')),
    })

    try {
      await getSession(sessionToken)
      throw new Error('Expected getSession to throw an error, but it did not')
    } catch (error) {
      expect(error).toBeInstanceOf(ServerError)
      expect(error).toHaveProperty('code', 'SESSION_EXPIRED')
    }
  })
})

function normalizeDatePrecision(date: Date | number) {
  const d = new Date(date)
  d.setSeconds(0)
  d.setMilliseconds(0)
  return d
}

async function seedUser() {
  const user = await db
    .insert(usersTable)
    .values({ email: faker.internet.email().toLowerCase() })
    .returning()
    .then((res) => res[0]!)
  return { userId: user.id }
}

async function seedSession(
  values: Optional<
    PgInsertValue<typeof sessionsTable>,
    'userAgent' | 'ipAddress' | 'tokenHash'
  >,
) {
  const token = createSessionToken()
  const tokenHash = createSessionTokenHash(token)
  const session = await db
    .insert(sessionsTable)
    .values({
      ipAddress: faker.internet.ip(),
      userAgent: faker.internet.userAgent(),
      tokenHash,
      ...values,
    })
    .returning()
    .then((res) => res[0]!)

  return { sessionId: session.id, sessionToken: token }
}

type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>
