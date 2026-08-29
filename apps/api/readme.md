# API

## Auth

- Rate limits
- Passwordless email login
- Renew sessions automatically

## Logging

Logging goes through [evlog](https://evlog.dev), configured once in
`src/lib/logger.ts`. The model is **one wide event per request** rather than a
line per thing that happens: `app.use(evlog())` opens the event, handlers add
context to it, and it is emitted with status and duration when the response
finishes.

Add context from a route with `ctx.get('log')`:

```ts
authRouter.post('/email', async (ctx) => {
  const log = ctx.get('log')
  log.set({ auth: { step: 'email', email } })
  log.set({ user: { id: user.id } })
  // ...
})
```

Outside of a Hono handler — inside the GraphQL `context` callback or
`maskError`, for example — use `useLogger()` from `~/lib/logger`, which resolves
the current request's logger through `AsyncLocalStorage`.

Errors are recorded centrally, so handlers only need to throw:

- `app.onError` logs 5xx with `log.error` and 4xx with `log.warn`. It logs the
  _original_ error rather than the `ServerError` it maps to, because
  `ServerError.from` collapses anything unrecognized into a generic 500.
- Yoga's `maskError` does the same for GraphQL, which otherwise swallows
  resolver errors into the response with no trace on the server.

Output is a pretty tree in development and one JSON line per request in
production. Tests run with `silent: true` so events are still built (and any
`ctx.get('log')` call still works) but nothing is printed. Note that
`enabled: false` and the `include`/`exclude` route filters are _not_
interchangeable with `silent` — anything that skips a request also leaves
`ctx.get('log')` undefined and makes `useLogger()` throw.

Nothing ships logs off the box yet. evlog has drain adapters for Axiom, OTLP,
Datadog, Better Stack and others — wire one up via `initLogger({ drain })`.

## Linting

Linting and formatting run on [oxlint and oxfmt](https://oxc.rs) via
`oxlint-config-alexandernanberg`. Note that `eslint-plugin-drizzle`'s
`enforce-delete-with-where` / `enforce-update-with-where` rules have no oxlint
equivalent, so `.delete()` and `.update()` calls are no longer checked for a
`.where(...)` clause — always double check those by hand.

## TODO

- [ ] Passkeys
- [ ] Change email?
