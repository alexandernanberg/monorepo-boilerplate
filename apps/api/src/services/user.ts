import { eq } from 'drizzle-orm'
import { db } from '~/db'
import { usersTable } from '~/db/schema'
import { ServerError } from '~/lib/server-error'
import { getSession, getSessionTokenFromRequest } from '~/services/session'

export type CurrentUser = Awaited<ReturnType<typeof getCurrentUser>>

async function getCurrentUser(req: Request) {
  const session = await getSession(getSessionTokenFromRequest(req))

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.id, session.userId),
    with: {},
  })

  // TODO: cache in redis?
  // TODO: what to do with deleted users?
  // TODO: filter out deleted roles and permissions?

  if (!user) {
    throw new ServerError(404, 'USER_NOT_FOUND', 'User not found')
  }

  return user
}

export { getCurrentUser }
