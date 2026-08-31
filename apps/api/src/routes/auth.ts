import { hash, verify } from '@node-rs/argon2'
import type { RandomReader } from '@oslojs/crypto/random'
import { generateRandomString } from '@oslojs/crypto/random'
import { eq, lte, sql } from 'drizzle-orm'
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
import type { EvlogVariables } from '~/lib/logger'
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

export const authRouter = new Hono<EvlogVariables>()

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

  const log = ctx.get('log')
  log.set({ auth: { step: 'signup', email } })

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

  const expiresAt = sql`now() + (${config.SIGNUP_CODE_TTL_MINUTES} || 'minutes')::interval`

  // One upsert rather than check-then-delete-then-insert. Two concurrent
  // signups for the same address would each pass a separate existence check and
  // then collide on the unique index, turning an orderly 409 into a 500.
  // `setWhere` hands the decision to Postgres: the row is replaced only when
  // the challenge already there has expired.
  const [challenge] = await db
    .insert(signupChallengesTable)
    .values({
      email,
      codeHash,
      expiresAt,
      ipAddress: ip,
      userAgent,
    })
    .onConflictDoUpdate({
      target: signupChallengesTable.email,
      set: {
        codeHash,
        expiresAt,
        ipAddress: ip,
        userAgent,
        createdAt: sql`now()`,
        failedAttempts: 0,
      },
      setWhere: lte(signupChallengesTable.expiresAt, sql`now()`),
    })
    .returning()

  if (!challenge) {
    throw new ServerError(
      409,
      'VERIFICATION_IN_PROGRESS',
      'Account verification is already in progress. Please check your inbox and spam folder.',
    )
  }

  await emailClient.sendMail({
    to: email,
    from: config.EMAIL_SENDER,
    subject: `Your signup code is: ${code}`,
    text: `Your signup code is: ${code}. The code is valid for ${config.SIGNUP_CODE_TTL_MINUTES} minutes.`,
  })

  log.set({ auth: { challengeSent: true } })

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

  const log = ctx.get('log')
  log.set({ auth: { step: 'signup/verify', email } })

  await signupVerifyRateLimiterEmail.consume(email)

  const signupChallenge = await db.query.signupChallengesTable.findFirst({
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
    // Deliberately not inside a transaction: the increment has to survive the
    // throw, and a wrapping transaction would roll it back — letting an
    // attacker guess forever. (This used to be worked around by issuing a raw
    // `COMMIT` mid-transaction and leaving Drizzle to roll back nothing.)
    const updated = await db
      .update(signupChallengesTable)
      .set({ failedAttempts: sql`${signupChallengesTable.failedAttempts} + 1` })
      .where(eq(signupChallengesTable.id, signupChallenge.id))
      .returning()
      .then((res) => res[0])

    log.set({ auth: { failedAttempts: updated?.failedAttempts } })

    throw new ServerError(400, 'INVALID_CODE', 'Invalid code')
  }

  // Redeeming the challenge *is* the delete: if it removes nothing, a
  // concurrent request already spent this code, so it is no longer valid.
  const consumed = await db
    .delete(signupChallengesTable)
    .where(eq(signupChallengesTable.id, signupChallenge.id))
    .returning()
    .then((res) => res[0])

  if (!consumed) {
    throw new ServerError(400, 'INVALID_CODE', 'Invalid code')
  }

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

  log.set({
    user: { id: session.userId },
    session: { id: session.id },
  })

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

  const log = ctx.get('log')
  log.set({ auth: { step: 'email', email } })

  await emailLoginRateLimiterEmail.consume(email)

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.email, email),
  })

  if (!user) {
    throw new ServerError(404, 'NO_ACCOUNT', 'Email not recognized')
  }

  log.set({ user: { id: user.id } })

  const code = generateCode()
  const codeHash = await hash(code)

  // Replaces any challenge the user already has, in one statement. The
  // delete-then-insert this used to be could interleave with a concurrent
  // request and leave two live challenges behind, and verification picks one of
  // them arbitrarily — so the code in the newest email might simply not work.
  await db
    .insert(loginChallengesTable)
    .values({
      userId: user.id,
      codeHash,
      expiresAt: sql`now() + (${config.LOGIN_CODE_TTL_MINUTES} || 'minutes')::interval`,
      ipAddress: ip,
      userAgent,
    })
    .onConflictDoUpdate({
      target: loginChallengesTable.userId,
      set: {
        codeHash,
        expiresAt: sql`now() + (${config.LOGIN_CODE_TTL_MINUTES} || 'minutes')::interval`,
        ipAddress: ip,
        userAgent,
        createdAt: sql`now()`,
        failedAttempts: 0,
      },
    })

  // TODO: location. "We have received a sign-in attempt from Stockholm, Sweden"

  await emailClient.sendMail({
    to: email,
    from: config.EMAIL_SENDER,
    subject: `Your login code is: ${code}`,
    text: `Your login code is: ${code}. The code is valid for ${config.LOGIN_CODE_TTL_MINUTES} minutes.`,
  })

  log.set({ auth: { challengeSent: true } })

  return ctx.body(null, { status: 204 })
})

///////////////////////////////////////////////////////////
// POST /auth/email/verify
///////////////////////////////////////////////////////////

const emailVerifyRateLimiterIp = new BucketRateLimiter(
  'email_login_verify_ip',
  {
    size: config.RATE_LIMIT_IP_BUCKET_SIZE,
    refillRateSeconds: config.RATE_LIMIT_IP_BUCKET_REFILL_RATE_SECONDS,
  },
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

  const log = ctx.get('log')
  log.set({ auth: { step: 'email/verify', email } })

  await emailVerifyRateLimiterEmail.consume(email)

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.email, email),
  })

  if (!user) {
    throw new ServerError(404, 'NO_ACCOUNT', 'Email not recognized')
  }

  log.set({ user: { id: user.id } })

  const loginChallenge = await db.query.loginChallengesTable.findFirst({
    where: eq(loginChallengesTable.userId, user.id),
  })

  if (!loginChallenge) {
    throw new ServerError(400, 'INVALID_CODE', 'Invalid code')
  }

  if (loginChallenge.expiresAt.getTime() < Date.now()) {
    throw new ServerError(410, 'CODE_EXPIRED', 'Code has expired')
  }

  if (loginChallenge.failedAttempts >= config.MAX_FAILED_EMAIL_LOGIN_ATTEMPTS) {
    throw new ServerError(
      429,
      'TOO_MANY_ATTEMPTS',
      'Maximum verification attempts exceeded. Please request a new code',
    )
  }

  if (!(await verify(loginChallenge.codeHash, code))) {
    // See the note on the signup equivalent: the increment must outlive the
    // throw, which is why there is no transaction around it.
    const updated = await db
      .update(loginChallengesTable)
      .set({ failedAttempts: sql`${loginChallengesTable.failedAttempts} + 1` })
      .where(eq(loginChallengesTable.id, loginChallenge.id))
      .returning()
      .then((res) => res[0])

    log.set({ auth: { failedAttempts: updated?.failedAttempts } })

    throw new ServerError(400, 'INVALID_CODE', 'Invalid code')
  }

  const consumed = await db
    .delete(loginChallengesTable)
    .where(eq(loginChallengesTable.id, loginChallenge.id))
    .returning()
    .then((res) => res[0])

  if (!consumed) {
    throw new ServerError(400, 'INVALID_CODE', 'Invalid code')
  }

  const token = createSessionToken()
  const session = await createSession(token, user.id, ip, userAgent)

  await emailVerifyRateLimiterEmail.reset(email)

  log.set({ session: { id: session.id } })

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

  ctx.get('log').set({
    auth: { step: 'logout' },
    user: { id: session.userId },
    session: { id: session.id },
  })

  return ctx.body(null, { status: 204 })
})

///////////////////////////////////////////////////////////
// GET /auth/session
///////////////////////////////////////////////////////////

authRouter.get('/session', async (ctx) => {
  const session = await getSession(getSessionTokenFromRequest(ctx.req.raw))

  ctx.get('log').set({
    user: { id: session.userId },
    session: { id: session.id },
  })

  return ctx.json(session)
})
