import { AsyncLocalStorage } from 'node:async_hooks'
import { auth } from '~/lib/auth'
import { ServerError } from '~/lib/server-error'

export type CurrentUser = NonNullable<
  Awaited<ReturnType<typeof auth.api.getSession>>
>['user']

const currentUserStore = new AsyncLocalStorage<CurrentUser>()

function runWithCurrentUser<T>(user: CurrentUser, fn: () => T): T {
  return currentUserStore.run(user, fn)
}

async function getCurrentUser(req: Request) {
  const fromStore = currentUserStore.getStore()
  if (fromStore) {
    return fromStore
  }

  const result = await auth.api.getSession({
    headers: req.headers,
  })

  if (!result?.user) {
    throw new ServerError(401, 'UNAUTHORIZED', 'Missing authorization')
  }

  return result.user
}

export { getCurrentUser, runWithCurrentUser }
