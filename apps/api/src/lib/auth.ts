import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { init } from '@paralleldrive/cuid2'
import { betterAuth } from 'better-auth'
import { bearer } from 'better-auth/plugins'
import { emailOTP } from 'better-auth/plugins/email-otp'
import { config, env } from '~/config'
import { db } from '~/db'
import * as schema from '~/db/schema'
import { emailClient } from '~/lib/email'
import { redis } from '~/lib/redis'

const createId = init({ length: 32 })

const idPrefix: Record<string, string> = {
  user: 'usr',
  session: 'sess',
  account: 'acc',
  verification: 'ver',
  twoFactor: '2fa',
  passkey: 'pk',
  organization: 'org',
  member: 'mem',
  invitation: 'inv',
}

export const auth = betterAuth({
  appName: 'api',
  secret: config.AUTH_SECRET,
  baseURL: config.AUTH_BASE_URL,
  basePath: '/auth',
  trustedOrigins: config.trustedOrigins,

  database: drizzleAdapter(db, {
    provider: 'pg',
    usePlural: true,
    schema,
  }),

  // Redis holds OTPs and rate-limit counters. Sessions stay in Postgres so
  // they can be listed and revoked with a normal query.
  secondaryStorage: {
    get: (key) => redis.get(key),
    getAndDelete: (key) => redis.getdel(key),
    async increment(key, ttl) {
      const results = await redis
        .multi()
        .incr(key)
        .expire(key, ttl, 'NX')
        .exec()
      const value = results?.[0]?.[1]
      if (typeof value !== 'number') {
        throw new Error('Redis increment failed')
      }
      return value
    },
    async set(key, value, ttl) {
      if (ttl) {
        await redis.set(key, value, 'EX', ttl)
      } else {
        await redis.set(key, value)
      }
    },
    async delete(key) {
      await redis.del(key)
    },
  },

  session: {
    expiresIn: config.SESSION_TTL_DAYS * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
    cookieCache: {
      enabled: false,
    },
    storeSessionInDatabase: true,
  },

  user: {
    additionalFields: {
      givenName: {
        type: 'string',
        required: false,
      },
      familyName: {
        type: 'string',
        required: false,
      },
    },
  },

  emailAndPassword: {
    enabled: false,
  },

  rateLimit: {
    enabled: true,
    storage: 'secondary-storage',
    window: 60,
    max: 100,
  },

  databaseHooks: {
    user: {
      create: {
        before: (user) =>
          Promise.resolve({
            data: {
              ...user,
              name: user.name.trim()
                ? user.name
                : (user.email.split('@')[0] ?? user.email),
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
        const prefix = idPrefix[model] ?? model.slice(0, 3).toLowerCase()
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
      sendVerificationOTP({ email, otp }) {
        return emailClient
          .sendMail({
            to: email,
            from: config.EMAIL_SENDER,
            subject: 'Your login code',
            text: `Your login code is: ${otp}. The code is valid for ${config.OTP_TTL_MINUTES} minutes.`,
          })
          .then(() => undefined)
      },
    }),
  ],

  telemetry: {
    enabled: env === 'production',
  },
})
