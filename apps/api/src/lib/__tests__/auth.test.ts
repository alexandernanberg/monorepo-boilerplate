/* oxlint-disable typescript/no-unsafe-assignment */
/* oxlint-disable typescript/no-unsafe-argument */
import { faker } from '@faker-js/faker'
import { beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  getRequestEnv,
  mailpit,
  resetDatabase,
  TestRequest,
} from '~/__tests__/test-utils'
import { app } from '~/app'
import { db } from '~/db'
import { sessionsTable, usersTable } from '~/db/schema'
import { redis } from '~/lib/redis'

beforeEach(async () => {
  setSystemTime()

  await Promise.all([
    redis.flushall(),
    mailpit.resetMessages(),
    resetDatabase(),
  ])
})

describe('POST /auth/email-otp/send-verification-otp', () => {
  test('sends an 8-digit code', async () => {
    const email = faker.internet.email().toLowerCase()

    const res = await sendOtp(email)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })

    const message = await readOtpMessage(email)
    expect(message.Subject).toBe('Your login code')
    expect(message.Subject).not.toMatch(/\d{8}/)
    expect(await readOtp(email)).toMatch(/^\d{8}$/)
  })

  test('rejects invalid email', async () => {
    const res = await app.fetch(
      TestRequest.json('/auth/email-otp/send-verification-otp', 'POST', {
        email: 'foo',
        type: 'sign-in',
      }),
      getRequestEnv(),
    )

    expect(res.status).toBe(400)
  })
})

describe('POST /auth/sign-in/email-otp', () => {
  test('creates a user and session on first sign-in', async () => {
    const email = faker.internet.email().toLowerCase()
    const at = email.indexOf('@')
    const localPart = at === -1 ? email : email.slice(0, at)
    const { token, json, res } = await signIn(email)

    expect(token).toBeTruthy()
    expect(json).toEqual(
      expect.objectContaining({
        token: expect.any(String),
        user: expect.objectContaining({
          email,
          emailVerified: true,
          name: localPart,
        }),
      }),
    )
    expect(res.headers.get('set-auth-token')).toBe(token)

    const user = await db.query.usersTable.findFirst({
      where: eq(usersTable.email, email),
    })
    expect(user).toBeDefined()
    expect(user!.id.startsWith('usr_')).toBe(true)
    expect(user!.name).toBe(localPart)

    const session = await db.query.sessionsTable.findFirst({
      where: eq(sessionsTable.userId, user!.id),
    })
    expect(session).toBeDefined()
    expect(session!.id.startsWith('sess_')).toBe(true)
    // Bearer plugin may append a signature; the DB stores the session token.
    expect(token.startsWith(session!.token)).toBe(true)
  })

  test('signs in an existing user without creating a second account', async () => {
    const email = faker.internet.email().toLowerCase()
    await signIn(email)
    await redis.flushall()
    await mailpit.resetMessages()

    await signIn(email)

    expect(
      await db.query.usersTable.findMany({
        where: eq(usersTable.email, email),
      }),
    ).toHaveLength(1)
  })

  test('rejects an invalid code', async () => {
    const email = faker.internet.email().toLowerCase()
    await sendOtp(email)

    const res = await app.fetch(
      TestRequest.json('/auth/sign-in/email-otp', 'POST', {
        email,
        otp: '00000000',
      }),
      getRequestEnv(),
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual(
      expect.objectContaining({
        code: 'INVALID_OTP',
      }),
    )
  })

  test('rejects too many failed attempts', async () => {
    const email = faker.internet.email().toLowerCase()
    await sendOtp(email)

    const ip = faker.internet.ipv4()
    const requestEnv = getRequestEnv(ip)
    const headers = { 'x-forwarded-for': ip }

    for (let i = 0; i < 3; i++) {
      const failed = await app.fetch(
        TestRequest.json(
          '/auth/sign-in/email-otp',
          'POST',
          { email, otp: `0000000${i}` },
          headers,
        ),
        requestEnv,
      )
      expect(failed.status).toBe(400)
    }

    const res = await app.fetch(
      TestRequest.json(
        '/auth/sign-in/email-otp',
        'POST',
        { email, otp: '00000003' },
        headers,
      ),
      requestEnv,
    )

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(
      expect.objectContaining({
        code: 'TOO_MANY_ATTEMPTS',
      }),
    )
  })
})

describe('GET /auth/get-session', () => {
  test('returns the current session', async () => {
    const email = faker.internet.email().toLowerCase()
    const { token, json } = await signIn(email)

    const res = await app.fetch(
      new TestRequest('/auth/get-session', 'GET').session(token),
      getRequestEnv(),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(
      expect.objectContaining({
        user: expect.objectContaining({
          id: json.user.id,
          email,
        }),
        session: expect.objectContaining({
          userId: json.user.id,
        }),
      }),
    )
  })

  test('rejects a missing or invalid token', async () => {
    const res = await app.fetch(
      new TestRequest('/auth/get-session', 'GET').session('not-a-session'),
      getRequestEnv(),
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toBeNull()
  })
})

describe('POST /auth/sign-out', () => {
  test('revokes the session', async () => {
    const email = faker.internet.email().toLowerCase()
    const { token, json } = await signIn(email)

    const res = await app.fetch(
      new TestRequest('/auth/sign-out', 'POST').session(token),
      getRequestEnv(),
    )

    expect(res.status).toBe(200)

    expect(
      await db.query.sessionsTable.findMany({
        where: eq(sessionsTable.userId, json.user.id),
      }),
    ).toHaveLength(0)

    const sessionRes = await app.fetch(
      new TestRequest('/auth/get-session', 'GET').session(token),
      getRequestEnv(),
    )
    expect(sessionRes.status).toBe(200)
    expect(await sessionRes.json()).toBeNull()
  })
})

describe('GraphQL viewer', () => {
  test('returns the current user', async () => {
    const email = faker.internet.email().toLowerCase()
    const { token, json } = await signIn(email)

    const res = await app.fetch(
      TestRequest.json('/graphql', 'POST', {
        query: '{ viewer { email databaseId } }',
      }).session(token),
      getRequestEnv(),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: {
        viewer: {
          email,
          databaseId: json.user.id,
        },
      },
    })
  })

  test('returns null when unauthenticated', async () => {
    const res = await app.fetch(
      TestRequest.json('/graphql', 'POST', {
        query: '{ viewer { email } }',
      }),
      getRequestEnv(),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: { viewer: null },
    })
  })

  test('returns null after the session is revoked', async () => {
    const email = faker.internet.email().toLowerCase()
    const { token } = await signIn(email)

    await app.fetch(
      new TestRequest('/auth/sign-out', 'POST').session(token),
      getRequestEnv(),
    )

    const res = await app.fetch(
      TestRequest.json('/graphql', 'POST', {
        query: '{ viewer { email } }',
      }).session(token),
      getRequestEnv(),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: { viewer: null },
    })
  })
})

async function sendOtp(email: string) {
  return await app.fetch(
    TestRequest.json('/auth/email-otp/send-verification-otp', 'POST', {
      email,
      type: 'sign-in',
    }),
    getRequestEnv(),
  )
}

async function readOtpMessage(email: string) {
  const inbox = await mailpit.getInbox(email)
  const id = inbox[0]?.ID
  if (!id) {
    throw new Error(`No OTP email for ${email}`)
  }
  return await mailpit.getMessage(id)
}

async function readOtp(email: string) {
  const message = await readOtpMessage(email)
  const code = message.Text.match(/(\d{8})/g)?.[0]
  expect(code).toBeDefined()
  return code!
}

async function signIn(email: string) {
  const sendRes = await sendOtp(email)
  expect(sendRes.status).toBe(200)

  const otp = await readOtp(email)
  const res = await app.fetch(
    TestRequest.json('/auth/sign-in/email-otp', 'POST', { email, otp }),
    getRequestEnv(),
  )
  expect(res.status).toBe(200)

  const json = (await res.json()) as {
    token?: string
    user: { id: string; email: string }
  }
  const token = res.headers.get('set-auth-token') ?? json.token

  if (!token) {
    throw new Error('Expected a session token in the sign-in response')
  }

  return { token, json, res }
}
