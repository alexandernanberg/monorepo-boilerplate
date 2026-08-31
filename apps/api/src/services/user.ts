import { and, eq, isNull } from 'drizzle-orm'
import { db } from '~/db'
import { usersTable } from '~/db/schema'
import { ServerError } from '~/lib/server-error'
import { getSession, getSessionTokenFromRequest } from '~/services/session'

export type CurrentUser = Awaited<ReturnType<typeof getCurrentUser>>

async function getCurrentUser(req: Request) {
  const session = await getSession(getSessionTokenFromRequest(req))

  // Soft-deleted users must not authenticate. Without the `deletedAt` filter a
  // deleted account keeps every session it had, and the loaders that serve
  // every *other* user already exclude them — so the account would be invisible
  // to the API while still being able to call it.
  const user = await db.query.usersTable.findFirst({
    where: and(eq(usersTable.id, session.userId), isNull(usersTable.deletedAt)),
  })

  // TODO: cache in redis?
  // TODO: filter out deleted roles and permissions?

  if (!user) {
    // Deliberately 401 rather than 404: the session names a user the caller may
    // no longer act as, which is an authentication outcome, and it keeps
    // deleted-vs-never-existed indistinguishable.
    throw new ServerError(401, 'INVALID_SESSION', 'Invalid session')
  }

  return user
}

export { getCurrentUser }
