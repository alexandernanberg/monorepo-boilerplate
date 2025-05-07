import { init } from '@paralleldrive/cuid2'
import { relations } from 'drizzle-orm'
import type { PgTimestampConfig } from 'drizzle-orm/pg-core'
import {
  boolean,
  index,
  inet,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

const createId = init({ length: 32 })

const createPrefixedId = (prefix: string) => () => `${prefix}_${createId()}`

const cuid = () => text()

const timestamptz = (config?: Omit<PgTimestampConfig, 'withTimezone'>) =>
  timestamp({ withTimezone: true, ...config })

////////////////////////////////////////////////////////////
// Users
////////////////////////////////////////////////////////////

export const usersTable = pgTable(
  'users',
  {
    id: cuid().primaryKey().$default(createPrefixedId('usr')),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz().notNull().defaultNow(),
    deletedAt: timestamptz(),
    givenName: text(),
    familyName: text(),
    email: text().notNull(),
    emailVerified: boolean().notNull().default(false),
  },
  (table) => [uniqueIndex().on(table.email)],
)

export type User = typeof usersTable.$inferSelect

export const usersRelations = relations(usersTable, ({ many }) => ({
  sessions: many(sessionsTable),
}))

////////////////////////////////////////////////////////////
// Email change requests
////////////////////////////////////////////////////////////

export const emailChangeRequestsTable = pgTable(
  'email_change_requests',
  {
    id: cuid().primaryKey().$default(createPrefixedId('ecr')),
    createdAt: timestamptz().notNull().defaultNow(),
    expiresAt: timestamptz().notNull(),
    verifiedAt: timestamptz(),
    userId: cuid()
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    oldEmail: text().notNull(),
    newEmail: text().notNull(),
    codeHash: text().notNull(),
    ipAddress: inet().notNull(),
    userAgent: text().notNull(),
  },
  (table) => [index().on(table.newEmail), index().on(table.userId)],
)

export type EmailChangeRequest = typeof emailChangeRequestsTable.$inferSelect

////////////////////////////////////////////////////////////
// Signup challenges
////////////////////////////////////////////////////////////

export const signupChallengesTable = pgTable(
  'signup_challenges',
  {
    id: cuid().primaryKey().$default(createPrefixedId('sgc')),
    createdAt: timestamptz().notNull().defaultNow(),
    expiresAt: timestamptz().notNull(),
    codeHash: text().notNull(),
    failedAttempts: integer().notNull().default(0),
    email: text().notNull(),
    ipAddress: inet().notNull(),
    userAgent: text().notNull(),
  },
  (table) => [uniqueIndex().on(table.email)],
)

export type SignupChallenge = typeof signupChallengesTable.$inferSelect

////////////////////////////////////////////////////////////
// Login challenges
////////////////////////////////////////////////////////////

export const loginChallengesTable = pgTable(
  'login_challenges',
  {
    id: cuid().primaryKey().$default(createPrefixedId('lgc')),
    createdAt: timestamptz().notNull().defaultNow(),
    expiresAt: timestamptz().notNull(),
    codeHash: text().notNull(),
    failedAttempts: integer().notNull().default(0),
    userId: cuid()
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    ipAddress: inet().notNull(),
    userAgent: text().notNull(),
  },
  (table) => [index().on(table.userId)],
)

export type LoginChallenge = typeof loginChallengesTable.$inferSelect

////////////////////////////////////////////////////////////
// Sessions
////////////////////////////////////////////////////////////

export const sessionsTable = pgTable(
  'sessions',
  {
    id: cuid().primaryKey().$default(createPrefixedId('sess')),
    createdAt: timestamptz().notNull().defaultNow(),
    expiresAt: timestamptz().notNull(),
    revokedAt: timestamptz(),
    lastActiveAt: timestamptz().notNull().defaultNow(),
    userId: cuid()
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    tokenHash: text().notNull(),
    ipAddress: inet().notNull(),
    userAgent: text().notNull(),
    // TODO: sudo mode, lastVerifiedAt (when the session was last verified by mfa)
  },
  (table) => [index().on(table.userId), uniqueIndex().on(table.tokenHash)],
)

export type Session = typeof sessionsTable.$inferSelect

export const sessionsRelations = relations(sessionsTable, ({ one }) => ({
  user: one(usersTable, {
    fields: [sessionsTable.userId],
    references: [usersTable.id],
  }),
}))
