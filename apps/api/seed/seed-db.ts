/**
 * Development seed data.
 *
 * Run with `pnpm db:seed`. Refuses to touch production — seeding is destructive
 * by nature and the connection string is whatever `DATABASE_URL` happens to say.
 */
import { faker } from '@faker-js/faker'
import { assertConfigIsValid, env } from '~/config'
import { client, db } from '~/db'
import { usersTable } from '~/db/schema'

assertConfigIsValid()

if (env === 'production') {
  throw new Error('Refusing to seed a production database.')
}

const USER_COUNT = 10

try {
  const users = await db
    .insert(usersTable)
    .values(
      Array.from({ length: USER_COUNT }, () => {
        const givenName = faker.person.firstName()
        const familyName = faker.person.lastName()

        return {
          givenName,
          familyName,
          email: faker.internet
            .email({ firstName: givenName, lastName: familyName })
            .toLowerCase(),
          emailVerified: true,
        }
      }),
    )
    // Emails are unique and faker can repeat itself, so a rerun tops the table
    // up rather than failing halfway through.
    .onConflictDoNothing({ target: usersTable.email })
    .returning({ id: usersTable.id, email: usersTable.email })

  console.log(`Seeded ${users.length} users:`)
  for (const user of users) {
    console.log(`  ${user.id}  ${user.email}`)
  }
} finally {
  await client.end()
}
