import DataLoader from 'dataloader'
import { inArray } from 'drizzle-orm'
import { db } from '~/db'
import type { User } from '~/db/schema'
import { usersTable } from '~/db/schema'
import { ForbiddenError, NotFoundError } from '~/lib/server-error'
import type { CurrentUser } from '~/services/user'

export function createDataSources(currentUser: CurrentUser | null) {
  // A missing row is `null`, so that a failed query still rejects the batch
  // and surfaces as a 500 rather than being mistaken for a 404 below.
  const userLoader = new DataLoader<string, User | null>(async (ids) => {
    const found = await db.query.usersTable.findMany({
      where: inArray(usersTable.id, [...ids]),
    })

    const usersById: Record<string, User> = {}
    for (const user of found) {
      usersById[user.id] = user
    }

    return ids.map((id) => usersById[id] ?? null)
  })

  if (currentUser) {
    userLoader.prime(currentUser.id, currentUser as User)
  }

  return {
    async loadUserById(id: string) {
      if (!currentUser || currentUser.id !== id) {
        throw new ForbiddenError('Forbidden')
      }

      const user = await userLoader.load(id)

      if (!user) {
        throw new NotFoundError('User not found')
      }

      return user
    },
  }
}
