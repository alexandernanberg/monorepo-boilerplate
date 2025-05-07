import DataLoader from 'dataloader'
import { and, inArray, isNull } from 'drizzle-orm'
import { db } from '~/db'
import type { User } from '~/db/schema'
import { usersTable } from '~/db/schema'
import { ForbiddenError, NotFoundError } from '~/lib/server-error'
import type { CurrentUser } from '~/services/user'

const DEBUG: boolean = false
function log(...data: Array<unknown>) {
  if (DEBUG) console.log(...data)
}

export function createDataSources(currentUser: CurrentUser) {
  const userLoader = new DataLoader<string, User>(async (ids) => {
    log('userLoader', ids)

    const users = await db.query.usersTable.findMany({
      where: and(
        inArray(usersTable.id, [...ids]),
        isNull(usersTable.deletedAt),
      ),
    })

    const usersById: Record<string, User> = {}
    for (const user of users) {
      usersById[user.id] = user
    }

    return ids.map((id) => usersById[id] ?? new Error(`User not found "${id}"`))
  })

  // Prime loader with current user data
  userLoader.prime(currentUser.id, currentUser)

  return {
    async loadUserById(id: string) {
      // TODO:
      // const accessibleUsersIds = await getAccessibleUsersIds()
      // if (!accessibleUsersIds.has(id)) {
      //   throw new ForbiddenError('Forbidden')
      // }

      if (currentUser.id !== id) {
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
