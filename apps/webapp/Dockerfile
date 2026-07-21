FROM node:22-alpine AS pruner
WORKDIR /app

COPY --chown=node:node . .
RUN npx -q turbo@2 prune webapp --docker
RUN find . -name "node_modules" -type d -prune -exec rm -rf '{}' +

# Base strategy to have layer caching
FROM node:22-alpine AS base
RUN apk add openssl dumb-init libc6-compat
WORKDIR /app
COPY --chown=node:node .gitignore .gitignore
COPY --from=pruner --chown=node:node /app/out/json/ .
COPY --from=pruner --chown=node:node /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner --chown=node:node /app/out/pnpm-workspace.yaml ./pnpm-workspace.yaml

## Dev deps
FROM base AS dev-deps
WORKDIR /app

RUN npm install -g pnpm@10.34.5
ENV NODE_ENV development
RUN pnpm install --ignore-scripts --frozen-lockfile

## Production deps
FROM base AS production-deps
WORKDIR /app

RUN npm install -g pnpm@10.34.5
ENV NODE_ENV production
RUN pnpm install --prod --frozen-lockfile

## Builder (builds the webapp)
FROM base AS builder
WORKDIR /app
ARG SENTRY_AUTH_TOKEN


RUN npm install -g pnpm@10.34.5

COPY --from=pruner --chown=node:node /app/out/full/ .
COPY --from=dev-deps --chown=node:node /app/ .
COPY apps/webapp/.prod.env .env
# Only configure sentry-cli when a token is provided; an empty .sentryclirc
# makes the Sentry webpack plugin attempt (and fail) source map uploads.
RUN if [ -n "$SENTRY_AUTH_TOKEN" ]; then \
      echo "SENTRY_AUTH_TOKEN=$SENTRY_AUTH_TOKEN" >> .env && \
      printf '[auth]\ntoken=%s\n' "$SENTRY_AUTH_TOKEN" > /app/apps/webapp/.sentryclirc; \
    fi
COPY --chown=node:node turbo.json turbo.json
RUN pnpm run build --filter=webapp...


# Runner
FROM node:22-alpine AS runner
RUN apk add --no-cache dumb-init bash
WORKDIR /app
RUN npm install -g pnpm@10.34.5
ENV NODE_ENV production

COPY --from=builder  --chown=node:node /app/apps/webapp/.next/standalone ./
COPY --from=builder  --chown=node:node /app/apps/webapp/.next/static ./apps/webapp/.next/static
COPY --from=builder  --chown=node:node /app/apps/webapp/public ./apps/webapp/public
COPY --from=builder  --chown=node:node /app/apps/webapp/package.json ./apps/webapp/package.json
COPY --from=builder  --chown=node:node /app/apps/webapp/entrypoint.sh ./apps/webapp/entrypoint.sh

EXPOSE 3000

USER node

CMD ["sh", "./apps/webapp/entrypoint.sh"]