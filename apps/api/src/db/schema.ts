import { init } from '@paralleldrive/cuid2'
import { relations } from 'drizzle-orm'
import type { PgTimestampConfig } from 'drizzle-orm/pg-core'
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

const createId = init({ length: 32 })

const createPrefixedId = (prefix: string) => () => `${prefix}_${createId()}`

const timestamptz = (config?: Omit<PgTimestampConfig, 'withTimezone'>) =>
  timestamp({ withTimezone: true, ...config })

////////////////////////////////////////////////////////////
// Users
////////////////////////////////////////////////////////////

export const users = pgTable(
  'users',
  {
    id: text().primaryKey().$defaultFn(createPrefixedId('usr')),
    name: text().notNull(),
    email: text().notNull(),
    emailVerified: boolean().notNull().default(false),
    image: text(),
    givenName: text(),
    familyName: text(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex().on(table.email)],
)

export type User = typeof users.$inferSelect

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  accounts: many(accounts),
}))

////////////////////////////////////////////////////////////
// Sessions
////////////////////////////////////////////////////////////

export const sessions = pgTable(
  'sessions',
  {
    id: text().primaryKey().$defaultFn(createPrefixedId('sess')),
    expiresAt: timestamptz().notNull(),
    token: text().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    ipAddress: text(),
    userAgent: text(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (table) => [index().on(table.userId), uniqueIndex().on(table.token)],
)

export type Session = typeof sessions.$inferSelect

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}))

////////////////////////////////////////////////////////////
// Accounts (OAuth / credential links)
////////////////////////////////////////////////////////////

export const accounts = pgTable(
  'accounts',
  {
    id: text().primaryKey().$defaultFn(createPrefixedId('acc')),
    issuer: text().notNull(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamptz(),
    refreshTokenExpiresAt: timestamptz(),
    scope: text(),
    password: text(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex().on(table.issuer, table.accountId),
    index().on(table.userId),
  ],
)

export type Account = typeof accounts.$inferSelect

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}))

////////////////////////////////////////////////////////////
// Verifications (email OTP, magic links, …)
////////////////////////////////////////////////////////////

export const verifications = pgTable(
  'verifications',
  {
    id: text().primaryKey().$defaultFn(createPrefixedId('ver')),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamptz().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index().on(table.identifier)],
)

export type Verification = typeof verifications.$inferSelect
