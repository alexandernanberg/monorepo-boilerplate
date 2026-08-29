###########################################################
# Base
###########################################################
FROM oven/bun:1 AS base

ENV PNPM_HOME="/pnpm"
ENV DO_NOT_TRACK=1
# `pnpm install --prod` over the full tree wants to remove node_modules, and
# prompts for it; a docker RUN has no TTY to answer with.
ENV CI=true

WORKDIR /app

# The bun image ships no package manager, so install the pinned pnpm. It runs
# on bun's `node` shim, and turbo shells out to it to run package scripts.
COPY package.json .
RUN bun install -g "$(bun -e "console.log(require('./package.json').packageManager)")"

###########################################################
# Sourcer
###########################################################
FROM base AS sourcer

RUN bun install -g "turbo@$(bun -e "console.log(require('./package.json').devDependencies.turbo)")"

COPY . .
RUN turbo prune api --docker

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

RUN turbo run build --filter=api...

##########################################################
# Runtime
##########################################################
FROM oven/bun:1 AS runtime

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 apiuser && \
  adduser --system --uid 1001 apiuser

USER apiuser

WORKDIR /app

COPY --from=prod-deps /app/ .
COPY --from=builder /app/apps/api/dist ./apps/api/dist

WORKDIR /app/apps/api

CMD ["bun", "start"]
