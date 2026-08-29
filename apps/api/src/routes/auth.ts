import { hash, verify } from '@node-rs/argon2'
import type { RandomReader } from '@oslojs/crypto/random'
import { generateRandomString } from '@oslojs/crypto/random'
import { and, eq, gt, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { config } from '~/config'
import { db } from '~/db'
import {
  loginChallengesTable,
  signupChallengesTable,
  usersTable,
} from '~/db/schema'
import { emailClient } from '~/lib/email'
import { BucketRateLimiter, ThrottlingRateLimiter } from '~/lib/rate-limiter'
import { BadRequestError, ServerError } from '~/lib/server-error'
import { getRequestIp, safeJSONParse } from '~/lib/utils'
import {
  createSession,
  createSessionDto,
  createSessionToken,
  getSession,
  getSessionTokenFromRequest,
  revokeSession,
} from '~/services/session'

export const authRouter = new Hono()

///////////////////////////////////////////////////////////
// POST /auth/signup
///////////////////////////////////////////////////////////

const signupRateLimiterIp = new BucketRateLimiter('signup_ip', {
  size: config.RATE_LIMIT_IP_BUCKET_SIZE,
  refillRateSeconds: config.RATE_LIMIT_IP_BUCKET_REFILL_RATE_SECONDS,
})

authRouter.post('/signup', async (ctx) => {
  const ip = getRequestIp(ctx)
  const userAgent = ctx.req.header('user-agent') ?? ''

  await signupRateLimiterIp.consume(ip, 1)

  if (ctx.req.header('content-type') !== 'application/json') {
    throw new BadRequestError('Content-Type must be application/json')
  }

  const body = safeJSONParse(await ctx.req.text()) ?? {}
  const { email } = z.object({ email: z.email().toLowerCase() }).parse(body)

  const existingUser = await db.query.usersTable.findFirst({
    where: eq(usersTable.email, email),
  })

  if (existingUser) {
    throw new ServerError(
      409,
      'ACCOUNT_EXISTS',
      'An account with the provided email already exists',
    )
  }

  const code = generateCode()
  const codeHash = await hash(code)

  await db.transaction(async (tx) => {
    const existingCode = await tx.query.signupChallengesTable.findFirst({
      where: and(
        eq(signupChallengesTable.email, email),
        gt(signupChallengesTable.expiresAt, sql`now()`),
      ),
    })

    if (existingCode) {
      throw new ServerError(
        409,
        'VERIFICATION_IN_PROGRESS',
        'Account verification is already in progress. Please check your inbox and spam folder.',
      )
    }

    await tx
      .delete(signupChallengesTable)
      .where(eq(signupChallengesTable.email, email))

    await tx.insert(signupChallengesTable).values({
      email,
      codeHash,
      expiresAt: sql`now() + (${config.SIGNUP_CODE_TTL_MINUTES} || 'minutes')::interval`,
      ipAddress: ip,
      userAgent,
    })
  })

  await emailClient.sendMail({
    to: email,
    from: config.EMAIL_SENDER,
    subject: `Your signup code is: ${code}`,
    text: `Your signup code is: ${code}. The code is valid for 15 minutes.`,
  })

  return ctx.body(null, { status: 204 })
})

function generateCode() {
  const random: RandomReader = {
    read(bytes: Uint8Array) {
      crypto.getRandomValues(bytes)
    },
  }

  return generateRandomString(random, '0123456789', 8)
}

///////////////////////////////////////////////////////////
// POST /auth/signup/verify
///////////////////////////////////////////////////////////

const signupVerifyRateLimiterIp = new BucketRateLimiter('signup_verify_ip', {
  size: config.RATE_LIMIT_IP_BUCKET_SIZE,
  refillRateSeconds: config.RATE_LIMIT_IP_BUCKET_REFILL_RATE_SECONDS,
})

const signupVerifyRateLimiterEmail = new ThrottlingRateLimiter(
  'signup_verify_email',
)

authRouter.post('/signup/verify', async (ctx) => {
  const ip = getRequestIp(ctx)
  const userAgent = ctx.req.header('user-agent') ?? ''

  await signupVerifyRateLimiterIp.consume(ip, 1)

  if (ctx.req.header('content-type') !== 'application/json') {
    throw new BadRequestError('Content-Type must be application/json')
  }

  const body = safeJSONParse(await ctx.req.text()) ?? {}
  const { email, code } = z
    .object({ email: z.email().toLowerCase(), code: z.string() })
    .parse(body)

  await signupVerifyRateLimiterEmail.consume(email)

  await db.transaction(async (tx) => {
    const signupChallenge = await tx.query.signupChallengesTable.findFirst({
      where: eq(signupChallengesTable.email, email),
    })

    if (!signupChallenge) {
      throw new ServerError(400, 'INVALID_CODE', 'Invalid code')
    }

    if (signupChallenge.expiresAt.getTime() < Date.now()) {
      throw new ServerError(410, 'CODE_EXPIRED', 'Code has expired')
    }

    if (signupChallenge.failedAttempts >= config.MAX_FAILED_SIGNUP_ATTEMPTS) {
      throw new ServerError(
        429,
        'TOO_MANY_ATTEMPTS',
        'Maximum verification attempts exceeded. Please request a new code',
      )
    }

    if (!(await verify(signupChallenge.codeHash, code))) {
      await tx
        .update(signupChallengesTable)
        .set({
          failedAttempts: sql`${signupChallengesTable.failedAttempts} + 1`,
        })
        .where(eq(signupChallengesTable.id, signupChallenge.id))
        .returning()
        .then((res) => res[0]!)

      await tx.execute(sql`commit`)

      throw new ServerError(400, 'INVALID_CODE', 'Invalid code')
    }

    // Delete used code
    await tx
      .delete(signupChallengesTable)
      .where(eq(signupChallengesTable.email, email))
  })

  const token = createSessionToken()
  const session = await db.transaction(async (tx) => {
    const user = await tx
      .insert(usersTable)
      .values({ email, emailVerified: true })
      .returning()
      .then((res) => res[0]!)

    return await createSession(token, user.id, ip, userAgent, tx)
  })

  await signupVerifyRateLimiterEmail.reset(email)

  return ctx.json({
    token,
    session: createSessionDto(session),
  })
})

///////////////////////////////////////////////////////////
// POST /auth/email
///////////////////////////////////////////////////////////

const emailLoginRateLimiterIp = new BucketRateLimiter('email_login_ip', {
  size: config.RATE_LIMIT_IP_BUCKET_SIZE,
  refillRateSeconds: config.RATE_LIMIT_IP_BUCKET_REFILL_RATE_SECONDS,
})

const emailLoginRateLimiterEmail = new ThrottlingRateLimiter(
  'email_login_email',
)

authRouter.post('/email', async (ctx) => {
  const ip = getRequestIp(ctx)
  const userAgent = ctx.req.header('user-agent') ?? ''

  await emailLoginRateLimiterIp.consume(ip, 1)

  if (ctx.req.header('content-type') !== 'application/json') {
    throw new BadRequestError('Content-Type must be application/json')
  }

  const body = safeJSONParse(await ctx.req.text()) ?? {}
  const { email } = z.object({ email: z.email().toLowerCase() }).parse(body)

  await emailLoginRateLimiterEmail.consume(email)

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.email, email),
  })

  if (!user) {
    throw new ServerError(404, 'NO_ACCOUNT', 'Email not recognized')
  }

  const code = generateCode()
  const codeHash = await hash(code)

  await db.transaction(async (tx) => {
    // Delete existing code
    await tx
      .delete(loginChallengesTable)
      .where(eq(loginChallengesTable.userId, user.id))

    await tx
      .insert(loginChallengesTable)
      .values({
        userId: user.id,
        codeHash,
        expiresAt: sql`now() + (${config.LOGIN_CODE_TTL_MINUTES} || 'minutes')::interval`,
        ipAddress: ip,
        userAgent,
      })
      .returning()
      .then((res) => res[0]!)
  })

  // TODO: location. "We have received a sign-in attempt from Stockholm, Sweden"

  await emailClient.sendMail({
    to: email,
    from: config.EMAIL_SENDER,
    subject: `Your login code is: ${code}`,
    text: `Your login code is: ${code}. The code is valid for 15 minutes.`,
  })

  return ctx.body(null, { status: 204 })
})

///////////////////////////////////////////////////////////
// POST /auth/email/verify
///////////////////////////////////////////////////////////

const emailVerifyRateLimiterIp = new BucketRateLimiter(
  'email_login_verify_ip',
  { size: config.RATE_LIMIT_IP_BUCKET_SIZE, refillRateSeconds: 2 },
)

const emailVerifyRateLimiterEmail = new ThrottlingRateLimiter(
  'email_login_verify_email',
)

authRouter.post('/email/verify', async (ctx) => {
  const ip = getRequestIp(ctx)
  const userAgent = ctx.req.header('user-agent') ?? ''

  await emailVerifyRateLimiterIp.consume(ip, 1)

  if (ctx.req.header('content-type') !== 'application/json') {
    throw new BadRequestError('Content-Type must be application/json')
  }

  const body = safeJSONParse(await ctx.req.text()) ?? {}
  const { email, code } = z
    .object({ email: z.email().toLowerCase(), code: z.string() })
    .parse(body)

  await emailVerifyRateLimiterEmail.consume(email)

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.email, email),
  })

  if (!user) {
    throw new ServerError(404, 'NO_ACCOUNT', 'Email not recognized')
  }

  await db.transaction(async (tx) => {
    const loginChallenge = await tx.query.loginChallengesTable.findFirst({
      where: eq(loginChallengesTable.userId, user.id),
    })

    if (!loginChallenge) {
      throw new ServerError(400, 'INVALID_CODE', 'Invalid code')
    }

    if (loginChallenge.expiresAt.getTime() < Date.now()) {
      throw new ServerError(410, 'CODE_EXPIRED', 'Code has expired')
    }

    if (
      loginChallenge.failedAttempts >= config.MAX_FAILED_EMAIL_LOGIN_ATTEMPTS
    ) {
      throw new ServerError(
        429,
        'TOO_MANY_ATTEMPTS',
        'Maximum verification attempts exceeded. Please request a new code',
      )
    }

    if (!(await verify(loginChallenge.codeHash, code))) {
      await tx
        .update(loginChallengesTable)
        .set({
          failedAttempts: sql`${loginChallengesTable.failedAttempts} + 1`,
        })
        .where(eq(loginChallengesTable.id, loginChallenge.id))
        .returning()
        .then((res) => res[0]!)

      await tx.execute(sql`commit`)

      throw new ServerError(400, 'INVALID_CODE', 'Invalid code')
    }

    // Delete used code
    await tx
      .delete(loginChallengesTable)
      .where(eq(loginChallengesTable.userId, user.id))
  })

  const token = createSessionToken()
  const session = await createSession(token, user.id, ip, userAgent)

  await emailVerifyRateLimiterEmail.reset(email)

  return ctx.json({
    token,
    session: createSessionDto(session),
  })
})

///////////////////////////////////////////////////////////
// POST /auth/logout
///////////////////////////////////////////////////////////

authRouter.post('/logout', async (ctx) => {
  const session = await getSession(getSessionTokenFromRequest(ctx.req.raw))
  await revokeSession(session.id)

  return ctx.body(null, { status: 204 })
})

///////////////////////////////////////////////////////////
// GET /auth/session
///////////////////////////////////////////////////////////

authRouter.get('/session', async (ctx) => {
  const session = await getSession(getSessionTokenFromRequest(ctx.req.raw))
  return ctx.json(session)
})
