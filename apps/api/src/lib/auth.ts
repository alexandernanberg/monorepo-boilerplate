import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { init } from '@paralleldrive/cuid2'
import { betterAuth } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { bearer } from 'better-auth/plugins'
import { emailOTP } from 'better-auth/plugins/email-otp'
import { identifyUser } from 'evlog/better-auth'
import { config } from '~/config'
import { db } from '~/db'
import {
  accountsTable,
  sessionsTable,
  usersTable,
  verificationsTable,
} from '~/db/schema'
import { emailClient } from '~/lib/email'
import { betterAuthLogger, useLogger } from '~/lib/logger'
import { redisStorage } from '~/lib/redis'

const createId = init({ length: 32 })

const idPrefix: Record<string, string> = {
  user: 'usr',
  session: 'sess',
  account: 'acc',
  verification: 'ver',
}

export const auth = betterAuth({
  appName: 'api',
  secret: config.AUTH_SECRET,
  baseURL: config.AUTH_BASE_URL,
  basePath: '/auth',
  trustedOrigins: config.trustedOrigins,
  logger: betterAuthLogger,

  database: drizzleAdapter(db, {
    provider: 'pg',
    usePlural: true,
    schema: {
      users: usersTable,
      sessions: sessionsTable,
      accounts: accountsTable,
      verifications: verificationsTable,
    },
  }),
  // OTPs, rate limits, session cache. Session rows still live in Postgres.
  secondaryStorage: redisStorage,

  session: {
    expiresIn: config.SESSION_TTL_DAYS * 24 * 60 * 60,
    storeSessionInDatabase: true,
  },

  user: {
    additionalFields: {
      givenName: { type: 'string', required: false },
      familyName: { type: 'string', required: false },
    },
  },

  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      '/email-otp/send-verification-otp': { window: 60, max: 5 },
      '/sign-in/email-otp': { window: 60, max: 10 },
    },
  },

  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      // `auth.api.*` (GraphQL's getSession) runs this hook too. Only stamp
      // auth fields when the HTTP request is actually `/auth/*`.
      const path = ctx.request && new URL(ctx.request.url).pathname
      if (!path?.startsWith('/auth')) {
        return
      }

      const reqLog = useLogger()
      reqLog.set({ auth: { path: ctx.path } })

      const session = ctx.context.newSession ?? ctx.context.session
      if (session) {
        identifyUser(reqLog, session)
      }
    }),
  },

  databaseHooks: {
    user: {
      create: {
        before: async (user) => ({
          data: {
            ...user,
            name: user.name.trim() || user.email.split('@')[0] || user.email,
          },
        }),
      },
    },
  },

  advanced: {
    ipAddress: {
      ipAddressHeaders: ['fly-client-ip', 'x-real-ip'],
    },
    database: {
      joins: true,
      generateId: ({ model }) => {
        const prefix = idPrefix[model] ?? model.slice(0, 3)
        return `${prefix}_${createId()}`
      },
    },
  },

  plugins: [
    bearer(),
    emailOTP({
      otpLength: config.OTP_LENGTH,
      expiresIn: config.OTP_TTL_MINUTES * 60,
      allowedAttempts: config.OTP_MAX_ATTEMPTS,
      storeOTP: 'hashed',
      async sendVerificationOTP({ email, otp }) {
        await emailClient.sendMail({
          to: email,
          from: config.EMAIL_SENDER,
          subject: 'Your login code',
          text: `Your login code is: ${otp}. The code is valid for ${config.OTP_TTL_MINUTES} minutes.`,
        })
      },
    }),
  ],
})
