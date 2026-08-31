# Monorepo boilerplate

A Turborepo workspace with a Bun + Hono API: passwordless email auth, GraphQL,
Postgres via Drizzle, Redis-backed rate limiting, and wide-event logging.

```
apps/
  api/          Hono server — REST auth routes and a GraphQL endpoint
packages/
  tsconfig/     Shared TypeScript configuration
```

## Requirements

- Node — version in `.nvmrc` (tooling only; the API runs on Bun)
- Bun — version in `.bun-version`
- pnpm 12
- Docker, for Postgres, Redis and Mailpit

## Getting started

```sh
pnpm install
docker compose up -d      # postgres:5432, redis:6379, mailpit:1025 (UI :8025)
pnpm --filter api db:migrate
pnpm --filter api db:seed # optional sample users
pnpm dev
```

The API listens on `http://localhost:4000`. Signup and login codes are emailed
to Mailpit — read them at <http://localhost:8025>.

## Commands

Run from the root; every task fans out through Turborepo.

| Command          | What it does                |
| ---------------- | --------------------------- |
| `pnpm dev`       | Run every app in watch mode |
| `pnpm build`     | Bundle for production       |
| `pnpm test`      | Run the test suites         |
| `pnpm typecheck` | `tsc --noEmit` everywhere   |
| `pnpm lint`      | oxlint                      |
| `pnpm format`    | oxfmt, writing in place     |

Per-app scripts take a filter: `pnpm --filter api db:generate`.

## Tests

`pnpm test` brings up `docker-compose.test.yml` (Postgres 5433, Redis 6380,
Mailpit 1026) itself, migrates, and tears it down afterwards. The suites are
integration-first — they exercise the real router against a real database
rather than mocking it.

To run against a stack that is already up — a CI job with service containers,
or to skip the compose cycle between runs — set `TEST_SERVICES_EXTERNAL=1`.

## Configuration

Everything is read from the environment through `apps/api/src/config.ts` and
validated with Zod. Development and test have working defaults; **production
requires each secret explicitly** and refuses to boot without them, reporting
the whole list at once rather than one restart at a time.

See [`apps/api/readme.md`](apps/api/readme.md#configuration) for the full table.

## Deploying

The image is built from the repo root:

```sh
docker build -f apps/api/Dockerfile --build-arg BUN_VERSION=$(cat .bun-version) .
```

`turbo prune` narrows the workspace to `api` and its dependencies, the app is
bundled with Bun, and the runtime stage carries only the bundle and the
migrations — no `node_modules`, no pnpm, no source. `apps/api/fly.toml` runs
migrations as a release command before any new instance takes traffic.
