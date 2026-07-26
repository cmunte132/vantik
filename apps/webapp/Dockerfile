# Built from the repo root: docker build -f apps/webapp/Dockerfile .
#
# The install stage deliberately depends on nothing but the workspace manifests
# and the lockfile. Editing source cannot reinstall node_modules; only a
# package.json or pnpm-lock.yaml change can. This replaces an earlier
# `turbo prune` stage that consumed the whole context, which meant any changed
# byte anywhere — a README, a .DS_Store — reinstalled ~1800 packages.
#
# There is no production-deps stage: `output: "standalone"` means Next traces
# what it needs and emits it into .next/standalone, so the runner takes only
# build output. The stage that used to be here installed a full production tree
# that nothing ever copied.

FROM node:24-alpine AS base
RUN apk add --no-cache openssl dumb-init libc6-compat
WORKDIR /app
# Installed once here rather than in each stage that needs it.
RUN npm install -g pnpm@10.34.5

## Workspace manifests, and nothing else. This layer is the cache key for the
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

## Dev deps — everything needed to build the webapp.
## The cache mount keeps the pnpm store across builds; without it every package
## came off the network on each run (`reused 0`).
FROM manifests AS dev-deps
ENV NODE_ENV development
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --ignore-scripts --frozen-lockfile \
      --store-dir=/pnpm/store --filter=webapp...

## Builder. Extends dev-deps instead of copying its /app across: that copy moved
## the entire node_modules tree byte for byte, with a --chown that forced a
## per-file rewrite.
FROM dev-deps AS builder
ARG SENTRY_AUTH_TOKEN
COPY . .
COPY apps/webapp/.prod.env .env
# Only configure sentry-cli when a token is provided; an empty .sentryclirc
# makes the Sentry webpack plugin attempt (and fail) source map uploads.
RUN if [ -n "$SENTRY_AUTH_TOKEN" ]; then \
      echo "SENTRY_AUTH_TOKEN=$SENTRY_AUTH_TOKEN" >> .env && \
      printf '[auth]\ntoken=%s\n' "$SENTRY_AUTH_TOKEN" > /app/apps/webapp/.sentryclirc; \
    fi
# The build stamp. .git is in .dockerignore, so the build genuinely cannot read
# the commit itself — it has to be passed in, and docker-compose.yaml derives it.
# Declared here rather than at the top of the stage so changing it does not
# invalidate the COPY above it.
#
# Both are in turbo.json's globalEnv: they are baked into the bundle and into the
# chunk namespace, so a turbo cache hit replayed under a new stamp would ship the
# wrong build id.
ARG VANTIK_BUILD_ID
ARG VANTIK_COMMIT
ENV VANTIK_BUILD_ID=$VANTIK_BUILD_ID
ENV VANTIK_COMMIT=$VANTIK_COMMIT
# .next/cache is Next's incremental compile cache. It is deliberately not part
# of the image — the runner takes only .next/standalone and .next/static — so a
# cache mount costs nothing and turns every build after the first into an
# incremental one.
RUN --mount=type=cache,id=next-cache,target=/app/apps/webapp/.next/cache,sharing=locked \
    --mount=type=cache,id=turbo,target=/app/.turbo,sharing=locked \
    pnpm run build --filter=webapp...

# Runner. No pnpm: the entrypoint execs node against the standalone server.
FROM node:24-alpine AS runner
RUN apk add --no-cache dumb-init bash
WORKDIR /app
ENV NODE_ENV production

COPY --from=builder --chown=node:node /app/apps/webapp/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/webapp/.next/static ./apps/webapp/.next/static
COPY --from=builder --chown=node:node /app/apps/webapp/public ./apps/webapp/public
COPY --from=builder --chown=node:node /app/apps/webapp/package.json ./apps/webapp/package.json
COPY --from=builder --chown=node:node /app/apps/webapp/entrypoint.sh ./apps/webapp/entrypoint.sh

EXPOSE 3000

USER node

CMD ["sh", "./apps/webapp/entrypoint.sh"]
