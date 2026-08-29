/* oxlint-disable typescript/no-unsafe-assignment */
/* oxlint-disable typescript/no-unsafe-argument */
import { faker } from '@faker-js/faker'
import { beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import ms from 'ms'
import {
  getRequestEnv,
  mailpit,
  resetDatabase,
  TestRequest,
} from '~/__tests__/test-utils'
import { app } from '~/app'
import { config } from '~/config'
import { db } from '~/db'
import {
  loginChallengesTable,
  sessionsTable,
  signupChallengesTable,
  usersTable,
} from '~/db/schema'
import { redis } from '~/lib/redis'
import type { createSessionDto } from '~/services/session'
import { createSession, createSessionToken } from '~/services/session'

beforeEach(async () => {
  setSystemTime()

  await Promise.all([
    redis.flushall(),
    mailpit.resetMessages(),
    resetDatabase(),
  ])
})

describe('POST /auth/signup', () => {
  test('generates code and sends email', async () => {
    const email = faker.internet.email()

    await requestSignup(email)
  })

  test('rejects invalid email', async () => {
    const res = await app.fetch(
      TestRequest.json('/auth/signup', 'POST', { email: 'foo' }),
      getRequestEnv(),
    )

    expect(res.status).toBe(422)
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    )
  })

  test('rejects email used by existing account', async () => {
    const email = faker.internet.email()

    await db.insert(usersTable).values({ email: email.toLowerCase() })

    const res = await app.fetch(
      TestRequest.json('/auth/signup', 'POST', { email }),
      getRequestEnv(),
    )

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: 'ACCOUNT_EXISTS' }),
    )
  })

  test('rejects email verification in progress', async () => {
    const email = faker.internet.email()

    await app.fetch(
      TestRequest.json('/auth/signup', 'POST', { email }),
      getRequestEnv(),
    )

    // Circumvent rate limiting
    await redis.flushall()

    const res = await app.fetch(
      TestRequest.json('/auth/signup', 'POST', { email }),
      getRequestEnv(),
    )

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: 'VERIFICATION_IN_PROGRESS' }),
    )
  })

  test.skip('enforces IP rate limit', async () => {
    const email = faker.internet.email()

    const count = 20

    await Promise.all(
      Array.from(
        { length: count },
        async () =>
          await app.fetch(
            TestRequest.json('/auth/signup', 'POST', { email }),
            getRequestEnv(),
          ),
      ),
    )

    const res = await app.fetch(
      TestRequest.json('/auth/signup', 'POST', { email }),
      getRequestEnv(),
    )

    expect(res.status).toBe(429)
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: 'RATE_LIMIT_EXCEEDED' }),
    )

    const resOtherIp = await app.fetch(
      TestRequest.json('/auth/signup', 'POST', {
        email: faker.internet.email(),
      }),
      getRequestEnv('127.0.0.2'),
    )

    expect(resOtherIp.status).toBe(204)
  })
})

describe('POST /auth/signup/verify', () => {
  test('verifies code and creates account', async () => {
    const email = faker.internet.email()

    const code = await requestSignup(email)

    const res = await app.fetch(
      TestRequest.json('/auth/signup/verify', 'POST', { email, code }),
      getRequestEnv(),
    )
    const json = (await res.json()) as {
      token: string
      session: ReturnType<typeof createSessionDto>
    }
    const sessionId = json.session.id

    expect(res.status).toBe(200)
    expect(json).toEqual(
      expect.objectContaining({
        token: expect.any(String),
        session: expect.objectContaining({
          id: expect.any(String),
          userId: expect.any(String),
        }),
      }),
    )

    expect(
      await db.query.signupChallengesTable.findMany({
        where: eq(signupChallengesTable.email, email),
      }),
    ).toHaveLength(0)

    expect(
      await db.query.sessionsTable.findFirst({
        where: eq(sessionsTable.id, sessionId),
        with: { user: true },
      }),
    ).toEqual(
      expect.objectContaining({
        id: sessionId,
        user: expect.objectContaining({
          email: email.toLowerCase(),
          emailVerified: true,
        }),
      }),
    )
  })

  test('rejects invalid email', async () => {
    const res = await app.fetch(
      TestRequest.json('/auth/signup/verify', 'POST', {
        email: 'foo',
        code: '',
      }),
      getRequestEnv(),
    )
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(json).toEqual(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
      }),
    )
  })

  test('rejects if account has not been initiated', async () => {
    const res = await app.fetch(
      TestRequest.json('/auth/signup/verify', 'POST', {
        email: faker.internet.email(),
        code: '',
      }),
      getRequestEnv(),
    )
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json).toEqual(
      expect.objectContaining({
        code: 'INVALID_CODE',
      }),
    )
  })

  test('rejects expired code', async () => {
    const email = faker.internet.email()

    const code = await requestSignup(email)

    setSystemTime(Date.now() + ms(`${config.SIGNUP_CODE_TTL_MINUTES}m`))

    const res = await app.fetch(
      TestRequest.json('/auth/signup/verify', 'POST', { email, code }),
      getRequestEnv(),
    )
    const json = await res.json()

    expect(res.status).toBe(410)
    expect(json).toEqual(
      expect.objectContaining({
        code: 'CODE_EXPIRED',
      }),
    )
  })

  test('rejects invalid code', async () => {
    const email = faker.internet.email()

    await requestSignup(email)

    const res = await app.fetch(
      TestRequest.json('/auth/signup/verify', 'POST', {
        email,
        code: '123456',
      }),
      getRequestEnv(),
    )
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json).toEqual(
      expect.objectContaining({
        code: 'INVALID_CODE',
      }),
    )
  })

  test('rejects too many failed attempts', async () => {
    const email = faker.internet.email()

    await requestSignup(email)

    const count = config.MAX_FAILED_SIGNUP_ATTEMPTS
    for (let i = 0; i < count; i++) {
      await app.fetch(
        TestRequest.json('/auth/signup/verify', 'POST', {
          email,
          code: `12345${i}`,
        }),
        getRequestEnv(),
      )

      await redis.flushall()
    }

    const res = await app.fetch(
      TestRequest.json('/auth/signup/verify', 'POST', {
        email,
        code: '123456',
      }),

      getRequestEnv(),
    )
    const json = await res.json()

    expect(res.status).toBe(429)
    expect(json).toEqual(
      expect.objectContaining({
        code: 'TOO_MANY_ATTEMPTS',
      }),
    )
  })

  test.skip('enforces IP rate limit', async () => {
    const email = faker.internet.email()

    await app.fetch(
      TestRequest.json('/auth/signup/verify', 'POST', {
        email,
        code: '123456',
      }),
      getRequestEnv(),
    )

    const res = await app.fetch(
      TestRequest.json('/auth/signup/verify', 'POST', {
        email,
        code: '123456',
      }),
      getRequestEnv(),
    )

    expect(res.status).toBe(429)
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: 'RATE_LIMIT_EXCEEDED' }),
    )
  })

  test('enforces rate limit for email attempts', async () => {
    const email = faker.internet.email()

    const count = 10
    for (let i = 0; i < count; i++) {
      await app.fetch(
        TestRequest.json('/auth/signup/verify', 'POST', {
          email,
          code: `12345${i}`,
        }),
        getRequestEnv(`127.0.1.${i}`),
      )
    }

    const res = await app.fetch(
      TestRequest.json('/auth/signup/verify', 'POST', {
        email,
        code: '123456',
      }),
      getRequestEnv(),
    )

    expect(res.status).toBe(429)
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: 'RATE_LIMIT_EXCEEDED' }),
    )
  })
})

describe('POST /auth/email', () => {
  test('generates code and sends email', async () => {
    const email = faker.internet.email()
    await seedUser(email)

    const res = await app.fetch(
      TestRequest.json('/auth/email', 'POST', { email }),
      getRequestEnv(),
    )

    expect(res.status).toBe(204)

    const inbox = await mailpit.getInbox(email.toLowerCase())
    const code = inbox[0]!.Subject.match(/(\d{8})/g)?.[0]

    expect(code).toBeDefined()
  })

  test('deletes old code', async () => {
    const email = faker.internet.email()
    await seedUser(email)
    const user = (await db.query.usersTable.findFirst({
      where: eq(usersTable.email, email.toLocaleLowerCase()),
    }))!
    expect(user).toBeDefined()

    await app.fetch(
      TestRequest.json('/auth/email', 'POST', { email }),
      getRequestEnv(),
    )

    // Circumvent rate limiting
    await redis.flushall()

    expect(
      await db.query.loginChallengesTable.findMany({
        where: eq(loginChallengesTable.userId, user.id),
      }),
    ).toHaveLength(1)

    const res = await app.fetch(
      TestRequest.json('/auth/email', 'POST', { email }),
      getRequestEnv(),
    )

    expect(res.status).toBe(204)

    const inbox = await mailpit.getInbox(email.toLowerCase())
    const code = inbox[0]!.Subject.match(/(\d{8})/g)?.[0]

    expect(code).toBeDefined()

    expect(
      await db.query.loginChallengesTable.findMany({
        where: eq(loginChallengesTable.userId, user.id),
      }),
    ).toHaveLength(1)
  })

  test('rejects invalid email', async () => {
    const res = await app.fetch(
      TestRequest.json('/auth/email', 'POST', { email: 'foo' }),
      getRequestEnv(),
    )

    expect(res.status).toBe(422)
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    )
  })

  test('rejects unknown email', async () => {
    const email = faker.internet.email()

    const res = await app.fetch(
      TestRequest.json('/auth/email', 'POST', { email }),
      getRequestEnv(),
    )

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: 'NO_ACCOUNT' }),
    )
  })

  test.skip('enforces IP rate limit', async () => {
    const email = faker.internet.email()
    await seedUser(email)

    await app.fetch(
      TestRequest.json('/auth/email', 'POST', { email }),
      getRequestEnv(),
    )

    const res = await app.fetch(
      TestRequest.json('/auth/email', 'POST', { email }),
      getRequestEnv(),
    )

    expect(res.status).toBe(429)
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: 'RATE_LIMIT_EXCEEDED' }),
    )

    const email2 = faker.internet.email()
    await seedUser(email2)

    const resOtherIp = await app.fetch(
      TestRequest.json('/auth/email', 'POST', {
        email: email2,
      }),
      getRequestEnv('127.0.0.2'),
    )

    expect(resOtherIp.status).toBe(204)
  })

  test('enforces email rate limit', async () => {
    const email = faker.internet.email()
    await seedUser(email)

    const count = 10
    for (let i = 0; i < count; i++) {
      await app.fetch(
        TestRequest.json('/auth/email', 'POST', {
          email,
        }),
        getRequestEnv(`127.0.1.${i}`),
      )
    }

    const res = await app.fetch(
      TestRequest.json('/auth/email', 'POST', {
        email,
      }),
      getRequestEnv(),
    )

    expect(res.status).toBe(429)
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: 'RATE_LIMIT_EXCEEDED' }),
    )
  })
})

describe('POST /auth/email/verify', () => {
  test('verifies code and creates session', async () => {
    const email = faker.internet.email()
    const { userId } = await seedUser(email)
    const { sessionId } = await seedSession(userId)

    expect(
      await db.query.loginChallengesTable.findMany({
        where: eq(loginChallengesTable.userId, userId),
      }),
    ).toHaveLength(0)

    // TODO: check expires at, and other important fields
    expect(
      await db.query.sessionsTable.findFirst({
        where: eq(sessionsTable.id, sessionId),
        with: { user: true },
      }),
    ).toEqual(
      expect.objectContaining({
        id: sessionId,
        user: expect.objectContaining({
          email: email.toLowerCase(),
          emailVerified: true,
        }),
      }),
    )
  })

  test('rejects invalid email', async () => {
    const email = faker.internet.email()
    await seedUser(email)

    const res = await app.fetch(
      TestRequest.json('/auth/email/verify', 'POST', {
        email: 'foo',
        code: '',
      }),
      getRequestEnv(),
    )
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(json).toEqual(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
      }),
    )
  })

  test('rejects if account does not exist', async () => {
    const res = await app.fetch(
      TestRequest.json('/auth/email/verify', 'POST', {
        email: faker.internet.email(),
        code: '',
      }),
      getRequestEnv(),
    )
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json).toEqual(
      expect.objectContaining({
        code: 'NO_ACCOUNT',
      }),
    )
  })

  test('rejects if no active code exists', async () => {
    const email = faker.internet.email()
    await seedUser(email)

    const res = await app.fetch(
      TestRequest.json('/auth/email/verify', 'POST', {
        email,
        code: '',
      }),
      getRequestEnv(),
    )
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json).toEqual(
      expect.objectContaining({
        code: 'INVALID_CODE',
      }),
    )
  })

  test('rejects expired code', async () => {
    const email = faker.internet.email()
    await seedUser(email)

    const code = await requestLogin(email)

    setSystemTime(Date.now() + ms(`${config.LOGIN_CODE_TTL_MINUTES}m`))

    const res = await app.fetch(
      TestRequest.json('/auth/email/verify', 'POST', { email, code }),
      getRequestEnv(),
    )
    const json = await res.json()

    expect(res.status).toBe(410)
    expect(json).toEqual(
      expect.objectContaining({
        code: 'CODE_EXPIRED',
      }),
    )
  })

  test('rejects invalid code', async () => {
    const email = faker.internet.email()
    await seedUser(email)

    await requestLogin(email)

    const res = await app.fetch(
      TestRequest.json('/auth/email/verify', 'POST', {
        email,
        code: '123456',
      }),
      getRequestEnv(),
    )
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json).toEqual(
      expect.objectContaining({
        code: 'INVALID_CODE',
      }),
    )
  })

  test('rejects too many failed attempts', async () => {
    const email = faker.internet.email()
    await seedUser(email)

    await requestLogin(email)

    const count = config.MAX_FAILED_SIGNUP_ATTEMPTS
    for (let i = 0; i < count; i++) {
      await app.fetch(
        TestRequest.json('/auth/email/verify', 'POST', {
          email,
          code: `12345${i}`,
        }),
        getRequestEnv(),
      )

      await redis.flushall()
    }

    const res = await app.fetch(
      TestRequest.json('/auth/email/verify', 'POST', {
        email,
        code: '123456',
      }),

      getRequestEnv(),
    )
    const json = await res.json()

    expect(res.status).toBe(429)
    expect(json).toEqual(
      expect.objectContaining({
        code: 'TOO_MANY_ATTEMPTS',
      }),
    )
  })

  test('enforces IP rate limit', async () => {
    const email = faker.internet.email()

    await app.fetch(
      TestRequest.json('/auth/email/verify', 'POST', {
        email,
        code: '123456',
      }),
      getRequestEnv(),
    )

    const res = await app.fetch(
      TestRequest.json('/auth/email/verify', 'POST', {
        email,
        code: '123456',
      }),
      getRequestEnv(),
    )

    expect(res.status).toBe(429)
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: 'RATE_LIMIT_EXCEEDED' }),
    )
  })

  test('enforces rate limit for email attempts', async () => {
    const email = faker.internet.email()

    const count = 10
    for (let i = 0; i < count; i++) {
      await app.fetch(
        TestRequest.json('/auth/email/verify', 'POST', {
          email,
          code: `12345${i}`,
        }),
        getRequestEnv(`127.0.1.${i}`),
      )
    }

    const res = await app.fetch(
      TestRequest.json('/auth/email/verify', 'POST', {
        email,
        code: '123456',
      }),
      getRequestEnv(),
    )

    expect(res.status).toBe(429)
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: 'RATE_LIMIT_EXCEEDED' }),
    )
  })
})

describe('POST /auth/logout', () => {
  test('logs out user', async () => {
    const email = faker.internet.email()
    const { userId } = await seedUser(email)
    const { sessionId, sessionToken } = await seedSession(userId)

    const res = await app.fetch(
      new TestRequest(`/auth/logout`, 'POST').session(sessionToken),
      getRequestEnv(),
    )

    expect(res.status).toBe(204)

    expect(
      await db.query.sessionsTable.findFirst({
        where: eq(sessionsTable.id, sessionId),
      }),
    ).toEqual(
      expect.objectContaining({
        revokedAt: expect.any(Date),
      }),
    )
  })
})

describe('GET /auth/session', () => {
  test('returns current session', async () => {
    const email = faker.internet.email()
    const { userId } = await seedUser(email)
    const { sessionId, sessionToken } = await seedSession(userId)

    const res = await app.fetch(
      new TestRequest(`/auth/session`, 'GET').session(sessionToken),
      getRequestEnv(),
    )

    expect(res.status).toBe(200)

    expect(await res.json()).toEqual(
      expect.objectContaining({
        id: sessionId,
        userId,
      }),
    )
  })

  test('rejects unauthorized users', async () => {
    const res = await app.fetch(
      new TestRequest(`/auth/session`, 'GET').session('invalid session id'),
      getRequestEnv(),
    )

    expect(res.status).toBe(401)

    expect(await res.json()).toEqual(
      expect.objectContaining({
        code: 'INVALID_SESSION',
      }),
    )
  })
})

async function seedUser(email: string) {
  const user = await db
    .insert(usersTable)
    .values({ email: email.toLowerCase(), emailVerified: true })
    .returning()
    .then((res) => res[0]!)
  return { userId: user.id }
}

async function seedSession(userId: string) {
  const token = createSessionToken()
  const session = await createSession(
    token,
    userId,
    faker.internet.ipv4(),
    faker.internet.userAgent(),
  )
  return { sessionId: session.id, sessionToken: token, session }
}

async function requestSignup(email: string) {
  const res = await app.fetch(
    TestRequest.json('/auth/signup', 'POST', { email }),
    getRequestEnv(),
  )

  expect(res.status).toBe(204)

  const inbox = await mailpit.getInbox(email.toLowerCase())
  const code = inbox[0]!.Subject.match(/(\d{8})/g)?.[0]

  expect(code).toBeDefined()

  return code!
}

async function requestLogin(email: string) {
  const res = await app.fetch(
    TestRequest.json('/auth/email', 'POST', { email }),
    getRequestEnv(),
  )

  expect(res.status).toBe(204)

  const inbox = await mailpit.getInbox(email.toLowerCase())
  const code = inbox[0]!.Subject.match(/(\d{8})/g)?.[0]

  expect(code).toBeDefined()

  return code!
}
