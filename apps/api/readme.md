# API

## Auth

- Rate limits
- Passwordless email login
- Renew sessions automatically

Session tokens are 32 bytes from the CSPRNG, base32-encoded, and only their
SHA-256 hash is stored — a database dump does not hand over live sessions.

Not cuid2, though not because cuid2 is weak: at length 32 it hashes roughly 165
bits of CSPRNG-derived entropy with SHA3-512, which is ample. The reasons are
narrower — it falls back to `Math.random` when `globalThis.crypto` is missing,
and does so silently, where `getRandomValues` throws; and raw random bytes are
easier to audit than entropy accounting through a hash-and-truncate. Treat the
swap as hardening rather than a fix for a vulnerability.

### Account enumeration

`POST /auth/signup` answers `409 ACCOUNT_EXISTS` for an address that is already
registered, and `POST /auth/email` answers `404 NO_ACCOUNT` for one that is not.
Both let anyone test whether an email has an account here.

This is a deliberate trade for a clearer signup flow, not an oversight. To close
it, answer `204` from both regardless and send a "someone tried to sign up with
your address" email instead — the client then cannot tell the two cases apart.
Do that before launching anything where mere membership is sensitive.

### CSRF

`csrf()` is mounted, but note what actually protects this API: authentication is
an `Authorization: Bearer` header, and a cross-site form cannot set one. CSRF is
a cookie problem; the middleware is defence in depth for whenever cookies appear.

It is wrapped rather than used directly. Hono substitutes `text/plain` for a
missing `Content-Type` and treats that as a browser form post, so a bodyless
request — `POST /auth/logout` — was rejected with 403 unless it carried a
matching `Origin`. Browsers send one; mobile, CLI and server-to-server clients
do not, so logout failed for them while reporting nothing to the caller and
leaving the session live. Requests with neither a body nor a content-type are
now exempt; anything a form could actually send is still checked.

## Configuration

`src/config.ts` reads every value from the environment and validates it with
Zod. Development and test carry working defaults; production requires the
secrets explicitly and **refuses to boot** without them, listing everything
that is missing or malformed in one go.

| Variable                                                         | Default (dev)                  | Notes                                          |
| ---------------------------------------------------------------- | ------------------------------ | ---------------------------------------------- |
| `NODE_ENV`                                                       | `development`                  | `development`, `production` or `test`          |
| `PORT`                                                           | `4000`                         |                                                |
| `DATABASE_URL`                                                   | local Postgres                 | **Required in production**                     |
| `REDIS_HOST` / `REDIS_PORT`                                      | `localhost` / `6379`           | **Required in production**                     |
| `REDIS_USER` / `REDIS_PASSWORD`                                  | empty                          |                                                |
| `SMTP_HOST` / `SMTP_PORT`                                        | `localhost` / `1025`           | **Required in production**                     |
| `SMTP_USER` / `SMTP_PASSWORD`                                    | empty                          | **Required in production**                     |
| `SMTP_TLS`                                                       | `false` (`true` in production) |                                                |
| `EMAIL_SENDER`                                                   | `noreply@acme.inc`             | **Required in production**                     |
| `TRUST_PROXY`                                                    | `false`                        | See below                                      |
| `CORS_ORIGINS`                                                   | empty                          | Comma-separated; no headers emitted when empty |
| `MAX_REQUEST_BODY_BYTES`                                         | `65536`                        | Rejected before the body is read               |
| `GRAPHIQL_ENABLED`                                               | `true` (`false` in production) | Also gates introspection                       |
| `GRAPHQL_MAX_DEPTH`                                              | `12`                           |                                                |
| `SESSION_TTL_DAYS`                                               | `30`                           |                                                |
| `SESSION_LAST_ACTIVE_THRESHOLD_MINUTES`                          | `10`                           |                                                |
| `SIGNUP_CODE_TTL_MINUTES` / `LOGIN_CODE_TTL_MINUTES`             | `15`                           |                                                |
| `MAX_FAILED_SIGNUP_ATTEMPTS` / `MAX_FAILED_EMAIL_LOGIN_ATTEMPTS` | `3`                            |                                                |
| `RATE_LIMIT_IP_BUCKET_SIZE`                                      | `10`                           |                                                |
| `RATE_LIMIT_IP_BUCKET_REFILL_RATE_SECONDS`                       | `1`                            |                                                |
| `CLEANUP_INTERVAL_MINUTES`                                       | `60`                           | `0` disables the sweeper                       |
| `MIGRATE_ON_START`                                               | `false`                        | See Migrations                                 |
| `SHUTDOWN_TIMEOUT_SECONDS`                                       | `10`                           | Keep below the platform's grace period         |

`NODE_ENV` must be read as `process.env['NODE_ENV']`, never
`process.env.NODE_ENV`. Bun's bundler replaces the dotted form with its
_build-time_ value, which silently pins the built image to whatever environment
built it — unredacted logs, no SMTP auth, development config, and no error to
say so. `scripts/check-bundle.ts` runs as part of `build` and fails if it
reappears.

### Behind a proxy

`getConnInfo` reports the TCP peer, which behind a load balancer is the load
balancer: every request lands in one rate-limit bucket and every stored
`ipAddress` is the proxy. Set `TRUST_PROXY=true` and `Fly-Client-IP` /
`X-Forwarded-For` are believed instead.

Only set it when something upstream actually overwrites those headers. Exposed
directly, they are client-controlled — anyone could mint a fresh address per
request and never reach a limit. `TRUST_PROXY` assumes exactly one trusted hop,
so the _last_ `X-Forwarded-For` entry is used: each proxy appends the address it
received the connection from, making the rightmost the only one ours vouches for.

## Migrations

Generated with `pnpm db:generate` and applied with `pnpm db:migrate`, which runs
`src/migrate.ts` — a standalone entrypoint bundled next to `server.js`.

The history was squashed to a single `0000_init` covering the whole schema. Any
database created before that squash disagrees with the journal and must be
dropped and re-migrated — `docker compose down -v && docker compose up -d`, then
`pnpm db:migrate`. That is a one-time cost of starting from a boilerplate, not
something to repeat once real data exists.

In production, run it as its own step so exactly one process applies migrations
and a failure stops the deploy before new instances start serving.
`apps/api/fly.toml` does this with `release_command`. For single-instance
deploys where that ceremony is not worth it, `MIGRATE_ON_START=true` migrates
during boot instead, before the server accepts connections.

The `migrations/` directory ships inside the image; the runner looks for it
relative to itself, which differs between source, a local `dist/` build and the
container.

## Rate limiting

Two Redis-backed limiters in `src/lib/rate-limiter.ts`, both implemented as Lua
so the read-modify-write is atomic:

- `BucketRateLimiter` — a token bucket that absorbs a burst up to its size, then
  admits traffic at the refill rate. Its key expires exactly when the bucket
  would be full again; expiring sooner would silently hand back a full bucket
  and turn the limit into "max per interval" with no refill at all.
- `ThrottlingRateLimiter` — an escalating lockout (1s, 2s, 4s … 5min) that resets
  after an hour of inactivity or an explicit `reset()`. Used per-email on the
  verify routes, so guessing a code gets expensive while a user who succeeds
  clears their counter.

Both are registered with ioredis' `defineCommand`, which keeps the script SHA
and retries with `EVAL` on `NOSCRIPT`. Caching a SHA by hand means a Redis
restart fails every auth route until the process is redeployed.

## Cleanup

Expired sessions and challenges are swept every `CLEANUP_INTERVAL_MINUTES` by
`src/services/cleanup.ts`, bounded by an index on each table's `expires_at`.
Nothing deleted them before, so the tables grew for the life of the deployment.
Running several instances is harmless — the deletes are idempotent.

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

## TODO

- [ ] Passkeys
- [ ] Change email?
- [ ] Ship logs somewhere — evlog has drains for Axiom, OTLP, Datadog and
      others; wire one up via `initLogger({ drain })` and flush it on shutdown
- [ ] Decide on account enumeration before launch (see Auth)
- [ ] Query cost limiting, if the schema grows past what depth alone bounds
