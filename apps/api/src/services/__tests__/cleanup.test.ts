import { faker } from '@faker-js/faker'
import { beforeEach, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { resetDatabase } from '~/__tests__/test-utils'
import { db } from '~/db'
import {
  loginChallengesTable,
  sessionsTable,
  signupChallengesTable,
  usersTable,
} from '~/db/schema'
import { deleteExpiredRecords } from '~/services/cleanup'
import { createSessionToken, createSessionTokenHash } from '~/services/session'

/** Deliberately server-side: `expiresAt` is compared against Postgres' clock. */
const anHourAgo = sql`now() - interval '1 hour'`
const inAnHour = sql`now() + interval '1 hour'`

beforeEach(async () => {
  await resetDatabase()
})

async function seedUser() {
  const user = await db
    .insert(usersTable)
    .values({ email: faker.internet.email().toLowerCase() })
    .returning()
    .then((res) => res[0]!)

  return user.id
}

async function seedSession(userId: string, expiresAt: typeof anHourAgo) {
  return await db
    .insert(sessionsTable)
    .values({
      userId,
      expiresAt,
      tokenHash: createSessionTokenHash(createSessionToken()),
      ipAddress: faker.internet.ipv4(),
      userAgent: faker.internet.userAgent(),
    })
    .returning()
    .then((res) => res[0]!)
}

describe('deleteExpiredRecords', () => {
  test('deletes expired rows and keeps live ones', async () => {
    const userId = await seedUser()
    const otherUserId = await seedUser()

    const expiredSession = await seedSession(userId, anHourAgo)
    const liveSession = await seedSession(userId, inAnHour)

    await db.insert(signupChallengesTable).values([
      {
        email: 'expired@example.com',
        codeHash: 'x',
        expiresAt: anHourAgo,
        ipAddress: '203.0.113.1',
        userAgent: 'test',
      },
      {
        email: 'live@example.com',
        codeHash: 'x',
        expiresAt: inAnHour,
        ipAddress: '203.0.113.1',
        userAgent: 'test',
      },
    ])

    await db.insert(loginChallengesTable).values({
      userId: otherUserId,
      codeHash: 'x',
      expiresAt: anHourAgo,
      ipAddress: '203.0.113.1',
      userAgent: 'test',
    })

    const deleted = await deleteExpiredRecords()

    expect(deleted).toEqual({
      sessions: 1,
      signupChallenges: 1,
      loginChallenges: 1,
      emailChangeRequests: 0,
    })

    const sessions = await db.query.sessionsTable.findMany()
    expect(sessions.map((session) => session.id)).toEqual([liveSession.id])
    expect(sessions).not.toContainEqual(
      expect.objectContaining({ id: expiredSession.id }),
    )

    const challenges = await db.query.signupChallengesTable.findMany()
    expect(challenges.map((challenge) => challenge.email)).toEqual([
      'live@example.com',
    ])
  })

  test('is safe to run when there is nothing to delete', async () => {
    expect(await deleteExpiredRecords()).toEqual({
      sessions: 0,
      signupChallenges: 0,
      loginChallenges: 0,
      emailChangeRequests: 0,
    })
  })

  /**
   * A revoked session still has a future `expiresAt`. Sweeping it early would
   * destroy the record of the revocation before it lapses on its own.
   */
  test('leaves revoked but unexpired sessions alone', async () => {
    const userId = await seedUser()
    const session = await seedSession(userId, inAnHour)

    await db
      .update(sessionsTable)
      .set({ revokedAt: sql`now()` })
      .where(eq(sessionsTable.id, session.id))

    expect((await deleteExpiredRecords()).sessions).toBe(0)
  })
})
