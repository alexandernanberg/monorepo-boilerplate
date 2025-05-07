###########################################################
# Base
###########################################################
FROM node:22-alpine AS base

RUN apk update && apk add --no-cache libc6-compat jq curl bash

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV DO_NOT_TRACK=1

WORKDIR /app

RUN corepack enable

###########################################################
# Sourcer
###########################################################
FROM base AS sourcer

COPY package.json .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install -g turbo@$(jq -r '.devDependencies.turbo' package.json)

COPY . .
RUN turbo prune --scope=api --docker

###########################################################
# Deps
###########################################################
FROM base AS deps

COPY --from=sourcer /app/out/json/ .
COPY --from=sourcer /app/out/pnpm-lock.yaml ./pnpm-lock.yaml

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile

###########################################################
# Prod deps
###########################################################
FROM base AS prod-deps

COPY --from=sourcer /app/out/json/ .
COPY --from=sourcer /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=deps /app/ .

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --prod --frozen-lockfile

###########################################################
# Builder
###########################################################
FROM base AS builder

COPY --from=deps /app/ .
COPY --from=sourcer /app/out/full/ .

RUN curl -fsSL https://bun.sh/install | bash
ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"

RUN bun turbo run build --filter=api...

##########################################################
# Runtime
##########################################################
FROM oven/bun:1 AS runtime

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 apiuser && \
  adduser --system --uid 1001 apiuser

USER apiuser

COPY --from=prod-deps /app/ .

WORKDIR /app/apps/api

COPY --from=builder /app/apps/api/dist ./dist

CMD ["bun", "start"]