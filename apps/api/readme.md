# API

## Auth

Authentication is [Better Auth](https://better-auth.com), mounted at `/auth`.
Sessions are rows in Postgres — every `getSession` hits the database. Cookie
caching is off on purpose. Redis holds OTPs and rate-limit counters only.
The session token stored on the row is the bearer token (Better Auth does not
hash it), so treat database access as equivalent to session theft.

The current sign-in method is email OTP (passwordless). Passkeys, SSO and 2FA
are plugins you add to `src/lib/auth.ts` when an app needs them.

### Email OTP

```
POST /auth/email-otp/send-verification-otp
{ "email": "user@example.com", "type": "sign-in" }

POST /auth/sign-in/email-otp
{ "email": "user@example.com", "otp": "12345678" }
```

The sign-in response sets `set-auth-token`. Send it as
`Authorization: Bearer <token>` on later requests (GraphQL included). First
successful OTP for an email creates the user.

```
GET  /auth/get-session
POST /auth/sign-out
```

`GET /auth/get-session` follows Better Auth: a missing or invalid token is
`200` with a `null` body. GraphQL requires a session and answers `401`.

### Production

Required environment:

- `BETTER_AUTH_SECRET` (32+ chars)
- `BETTER_AUTH_URL` (public API origin)
- `APP_ORIGIN` (web app origin, CORS/CSRF)
- `DATABASE_URL`
- `REDIS_HOST`
- `EMAIL_SENDER`
- `SMTP_HOST`

Optional: `REDIS_PORT` (6379), `REDIS_USER`, `REDIS_PASSWORD`, `SMTP_PORT`
(587), `SMTP_TLS` (`true`/`false`), `SMTP_USER`, `SMTP_PASSWORD`.

## Logging

Logging goes through [evlog](https://evlog.dev), configured once in
`src/lib/logger.ts`. The model is **one wide event per request** rather than a
line per thing that happens: `app.use(evlog())` opens the event, handlers add
context to it, and it is emitted with status and duration when the response
finishes.

Add context from a route with `ctx.get('log')`:

```ts
const log = ctx.get('log')
log.set({ user: { id: user.id } })
```

Outside of a Hono handler — inside the GraphQL `context` callback or
`maskError`, for example — use `useLogger()` from `~/lib/logger`, which resolves
the current request's logger through `AsyncLocalStorage`.

Errors are recorded centrally, so handlers only need to throw:

- `app.onError` logs 5xx with `log.error` and 4xx with `log.warn`. It logs the
  _original_ error rather than the `ServerError` it maps to, because
  `ServerError.from` collapses anything unrecognized into a generic 500.
- Yoga's `maskError` does the same for GraphQL. Yoga's own logger is turned off
  (`logging: false`) — it dumped errors to the console unstructured and detached
  from the request that caused them.
- Parse and validation failures are the client's mistake, not ours. They are
  returned to the client as-is and recorded as warnings. Validation errors never
  reach `maskError`, so a small `onValidate` plugin catches those.

Note that GraphQL answers with `200` and an `errors` array, so the wide event's
`status` says nothing about whether a GraphQL request succeeded — its `level`
and `error` do.

Output is a pretty tree in development and one JSON line per request in
production. Tests run with `silent: true` so events are still built (and any
`ctx.get('log')` call still works) but nothing is printed. Note that
`enabled: false` and the `include`/`exclude` route filters are _not_
interchangeable with `silent` — anything that skips a request also leaves
`ctx.get('log')` undefined and makes `useLogger()` throw.

Nothing ships logs off the box yet. evlog has drain adapters for Axiom, OTLP,
Datadog, Better Stack and others — wire one up via `initLogger({ drain })`.

## Shutdown

`SIGTERM` (from Docker, Fly or Kubernetes) and `SIGINT` (Ctrl-C) start a
graceful shutdown, wired up in `src/server.ts`:

```ts
onShutdown('http server', () => server.stop())
onShutdown('database pool', () => client.end())
```

Registration order is teardown order, and tasks run one at a time. The HTTP
server goes first — Bun's `server.stop()` stops accepting connections and
resolves once the requests already in flight have answered — so everything
registered after it is still open while they finish. Register anything new the
same way: outside-in, so a draining request never loses something it is using.

The whole sequence has `SHUTDOWN_TIMEOUT_SECONDS`. A hung close is raced
against whatever time is left so the tasks behind it still run, then the
process exits rather than waiting to be `SIGKILL`ed. Keep that budget below
the platform's own grace period — `kill_timeout` in `fly.toml`,
`terminationGracePeriodSeconds` on Kubernetes. A second signal exits
immediately, which is what a second Ctrl-C expects.

The container's `CMD` execs `bun server.js` directly instead of going through
`bun run` or `bun start`. A script runner in between is another process that
has to forward the signal, and as PID 1 it would ignore `SIGTERM` outright.

Note that this is where a log drain gets flushed once one is configured —
`onShutdown('logs', () => drain.flush())` — otherwise the last events in the
buffer die with the process.

## Linting

Linting and formatting run on [oxlint and oxfmt](https://oxc.rs) via
`oxlint-config-alexandernanberg`. Note that `eslint-plugin-drizzle`'s
`enforce-delete-with-where` / `enforce-update-with-where` rules have no oxlint
equivalent, so `.delete()` and `.update()` calls are no longer checked for a
`.where(...)` clause — always double check those by hand.
