# syntax=docker/dockerfile:1
# Build from the monorepo root:
#   docker build -f apps/api/Dockerfile .
###########################################################
# Base — Bun + native pnpm 12 (no Node)
###########################################################
FROM oven/bun:1.4 AS base

USER root
WORKDIR /app

ENV CI=true
ENV DO_NOT_TRACK=1
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

COPY --from=ghcr.io/pnpm/pnpm:12.0.0 /opt/pnpm/pnpm /usr/local/bin/pnpm

###########################################################
# Sourcer
###########################################################
FROM base AS sourcer

COPY . .
RUN TURBO_VERSION="$(bun -e 'console.log(require("./package.json").devDependencies.turbo.replace(/^[^\d]+/, ""))')" \
  && pnpm dlx "turbo@${TURBO_VERSION}" prune api --docker

###########################################################
# Deps
###########################################################
FROM base AS deps

COPY --from=sourcer /app/out/json/ .
COPY --from=sourcer /app/out/pnpm-lock.yaml ./pnpm-lock.yaml

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile

###########################################################
# Builder
###########################################################
FROM deps AS builder

COPY --from=sourcer /app/out/full/ .
RUN pnpm exec turbo run build --filter=api...

###########################################################
# Runtime — bun bundle only, no node_modules / pnpm / source
###########################################################
FROM oven/bun:1.4-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=builder --chown=bun:bun /app/apps/api/dist ./

USER bun

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/'); if (!r.ok) process.exit(1)"]

CMD ["bun", "run", "server.js"]
