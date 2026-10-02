# Built from the repo root: docker build -f apps/webapp/Dockerfile .
#
# The install stage uses the workspace manifests, lockfile and dependency patches.
# Source changes do not cause another dependency install.
# A manifest, lockfile or patch change invalidates the install cache.
#
# The webapp builds to static files, so there are no production dependencies
# to install: the runner is nginx and the files in dist/.

FROM node:24-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app
# Installed once here rather than in each stage that needs it.
RUN npm install -g pnpm@10.34.5

## This stage supplies the manifests and patches for dependency installation.
## It excludes application source to preserve the install cache.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY apps/docs/package.json                 apps/docs/
COPY apps/sandbox-host/package.json         apps/sandbox-host/
COPY apps/server/package.json               apps/server/
COPY apps/webapp/package.json               apps/webapp/
COPY packages/agent-core/package.json       packages/agent-core/
COPY packages/cli/package.json              packages/cli/
COPY packages/types/package.json            packages/types/
COPY packages/ui/package.json               packages/ui/
COPY tooling/eslint-config/package.json     tooling/eslint-config/
COPY tooling/typescript-config/package.json tooling/typescript-config/

## Dev deps — everything needed to build the webapp.
## The cache mount keeps the pnpm store across builds; without it every package
## came off the network on each run (`reused 0`).
FROM manifests AS dev-deps
ENV NODE_ENV=development
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --ignore-scripts --frozen-lockfile \
      --store-dir=/pnpm/store --filter=webapp...

## Builder. Extends dev-deps instead of copying its /app across: that copy moved
## the entire node_modules tree byte for byte, with a --chown that forced a
## per-file rewrite.
FROM dev-deps AS builder
COPY . .
# The build stamp. .git is in .dockerignore, so the build genuinely cannot read
# the commit itself — it has to be passed in, and docker-compose.yaml derives it.
# Declared here rather than at the top of the stage so changing it does not
# invalidate the COPY above it.
#
# Both are in turbo.json's globalEnv: they are baked into the bundle, so a turbo
# cache hit replayed under a new stamp would ship the wrong build id.
ARG VANTIK_BUILD_ID
ARG VANTIK_COMMIT
ENV VANTIK_BUILD_ID=$VANTIK_BUILD_ID
ENV VANTIK_COMMIT=$VANTIK_COMMIT
# The workspace packages need no build first: vite.config.ts takes
# @vantikhq/types from source, and Tailwind scans the ui sources itself.
#
# Vite runs directly, not through `pnpm run`, and on one native thread. The
# pnpm process would sit in memory for the whole build, and each extra thread
# adds its own allocations. The build then fits beside a running stack in a
# 2 GiB podman VM.
RUN cd apps/webapp && \
    NODE_ENV=production \
    RAYON_NUM_THREADS=1 TOKIO_WORKER_THREADS=1 \
      node node_modules/vite/bin/vite.js build

# Runner. nginx serves the files and proxies /api/* to the server; see
# nginx.conf.template. The unprivileged image runs as a non-root user.
FROM nginxinc/nginx-unprivileged:1.29-alpine AS runner
COPY --from=builder /app/apps/webapp/dist /usr/share/nginx/html
COPY apps/webapp/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY apps/webapp/nginx-proxy.conf /etc/nginx/vantik-proxy.conf
COPY --chmod=0755 apps/webapp/nginx-build-id.envsh /docker-entrypoint.d/15-vantik-build-id.envsh

EXPOSE 3000
