# Monorepo boilerplate

pnpm + Turborepo starter with a Bun API (`apps/api`): Hono, GraphQL Yoga/Pothos, Drizzle/Postgres, Better Auth (email OTP), Redis, and evlog.

API-only today. `packages/*` is reserved for shared packages; add `apps/web` when you have a frontend. CORS already allows `http://localhost:3000`.

## Prerequisites

- Node 24 (`.nvmrc`)
- Bun 1.4 (`.bun-version`)
- pnpm 12 (`packageManager` in `package.json`)
- Docker

```bash
corepack enable
pnpm install
docker compose up -d
pnpm db:migrate
pnpm dev
```

| Service | URL                           |
| ------- | ----------------------------- |
| API     | http://localhost:4000         |
| GraphQL | http://localhost:4000/graphql |
| Mailpit | http://localhost:8025         |

Copy `apps/api/.env.example` to `apps/api/.env` to override local defaults — Bun reads it from the app directory, not the repo root. Variables exported in the shell (`PORT=5000 pnpm dev`) work too; `turbo.json` lists which ones are passed through. Production environment variables are listed in `apps/api/readme.md`.

## Scripts

- `pnpm dev` — API with hot reload
- `pnpm test` — starts `docker-compose.test.yml` itself
- `pnpm lint` / `pnpm typecheck` / `pnpm format`
- `pnpm build`
- `pnpm db:migrate` — apply Drizzle migrations

See `apps/api/readme.md` for auth, logging, and shutdown.
