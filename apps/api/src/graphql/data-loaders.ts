import DataLoader from 'dataloader'
import { inArray } from 'drizzle-orm'
import { db } from '~/db'
import type { User } from '~/db/schema'
import { users } from '~/db/schema'
import { ForbiddenError, NotFoundError } from '~/lib/server-error'
import type { CurrentUser } from '~/services/user'

const DEBUG: boolean = false
function log(...data: Array<unknown>) {
  if (DEBUG) console.log(...data)
}

export function createDataSources(currentUser: CurrentUser | null) {
  const userLoader = new DataLoader<string, User>(async (ids) => {
    log('userLoader', ids)

    const found = await db.query.users.findMany({
      where: inArray(users.id, [...ids]),
    })

    const usersById: Record<string, User> = {}
    for (const user of found) {
      usersById[user.id] = user
    }

    return ids.map((id) => usersById[id] ?? new Error(`User not found "${id}"`))
  })

  if (currentUser) {
    userLoader.prime(currentUser.id, currentUser as User)
  }

  return {
    async loadUserById(id: string) {
      if (!currentUser || currentUser.id !== id) {
        throw new ForbiddenError('Forbidden')
      }

      const user = await userLoader.load(id).catch(() => null)

      if (!user) {
        throw new NotFoundError('User not found')
      }

      return user
    },
  }
}
