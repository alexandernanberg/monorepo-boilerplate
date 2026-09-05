import { AsyncLocalStorage } from 'node:async_hooks'
import { auth } from '~/lib/auth'

export type CurrentUser = NonNullable<
  Awaited<ReturnType<typeof auth.api.getSession>>
>['user']

type Store = { user: CurrentUser | null }

const currentUserStore = new AsyncLocalStorage<Store>()

function runWithCurrentUser<T>(user: CurrentUser | null, fn: () => T): T {
  return currentUserStore.run({ user }, fn)
}

function getCurrentUser() {
  return currentUserStore.getStore()?.user ?? null
}

async function resolveSession(req: Request) {
  return await auth.api.getSession({
    headers: req.headers,
  })
}

export { getCurrentUser, resolveSession, runWithCurrentUser }
