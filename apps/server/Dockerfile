# Built from the repo root: docker build -f apps/server/Dockerfile .
#
# The install stages deliberately depend on nothing but the workspace manifests
# and the lockfile. Editing source cannot reinstall node_modules; only a
# package.json or pnpm-lock.yaml change can. This replaces an earlier
# `turbo prune` stage that consumed the whole context, which meant any changed
# byte anywhere — a README, a .DS_Store — reinstalled ~1800 packages twice.

FROM node:24-alpine AS base
RUN apk add --no-cache openssl dumb-init libc6-compat
WORKDIR /app
# Installed once here rather than in each stage that needs it.
RUN npm install -g pnpm@10.34.5

## Workspace manifests, and nothing else. This layer is the cache key for every
## install below, so it must not contain source.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/docs/package.json                 apps/docs/
COPY apps/server/package.json               apps/server/
COPY apps/webapp/package.json               apps/webapp/
COPY packages/agent-core/package.json       packages/agent-core/
COPY packages/cli/package.json              packages/cli/
COPY packages/services/package.json         packages/services/
COPY packages/types/package.json            packages/types/
COPY packages/ui/package.json               packages/ui/
COPY packages/vantik-sdk/package.json       packages/vantik-sdk/
COPY tooling/eslint-config/package.json     tooling/eslint-config/
COPY tooling/typescript-config/package.json tooling/typescript-config/

## Dev deps — everything needed to build the server.
## The cache mount keeps the pnpm store across builds; without it every package
## came off the network on each run (`reused 0`), twice per image.
FROM manifests AS dev-deps
ENV NODE_ENV development
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --ignore-scripts --frozen-lockfile \
      --store-dir=/pnpm/store --filter=server...

## Production deps — what actually ships in the runner.
FROM manifests AS production-deps
ENV NODE_ENV production
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --prod --frozen-lockfile \
      --store-dir=/pnpm/store --filter=server...
COPY apps/server/prisma/schema.prisma apps/server/prisma/schema.prisma

## Builder. Extends dev-deps instead of copying its /app across: that copy moved
## the entire node_modules tree byte for byte, with a --chown that forced a
## per-file rewrite.
FROM dev-deps AS builder
COPY . .
# The build runs through turbo, which reported `0 cached, 5 total` on every
# run because its cache directory never survived the build. Shared with the
# webapp image, so the packages both apps depend on are built once.
RUN --mount=type=cache,id=turbo,target=/app/.turbo,sharing=locked \
    pnpm run build --filter=server...

# Runner. No pnpm: the entrypoint calls prisma and node directly, which drops a
# 33MB layer from the runtime image.
FROM node:24-alpine AS runner
RUN apk add --no-cache openssl dumb-init bash
WORKDIR /app
ENV NODE_ENV production

COPY --from=production-deps --chown=node:node /app .
COPY --from=builder --chown=node:node /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=builder --chown=node:node /app/packages/types/dist ./apps/server/node_modules/@vantikhq/types/dist
COPY --from=builder --chown=node:node /app/packages/agent-core/dist ./apps/server/node_modules/@vantikhq/agent-core/dist
COPY --from=builder --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=builder --chown=node:node /app/apps/server/prisma ./apps/server/prisma
COPY --from=builder --chown=node:node /app/apps/server/templates ./apps/server/templates
COPY --from=builder --chown=node:node /app/apps/server/scripts ./apps/server/scripts

# The agent guides, served over /v1/agent-skill so the Agents screen can offer
# them as downloads instead of paths to go find in a checkout. Straight from the
# build context: they are authored in the docs app, which the server build does
# not otherwise pull in. Copied as a directory so a guide added later needs no
# change here.
COPY --chown=node:node apps/docs/skills ./apps/server/skills

EXPOSE 3001

USER node

CMD ["sh", "apps/server/scripts/entrypoint.sh"]
