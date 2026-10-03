# Built from the repo root: docker build -f apps/sandbox-host/Dockerfile .
#
# For Linux hosts only. The sandbox host starts microVMs, and in a container it
# can do that at a usable speed only with /dev/kvm passed through. On macOS no
# container gets hardware virtualisation, so there the sandbox host runs
# natively (see README.md, "Hosted agent runs").
#
# Debian rather than Alpine: Gondolin's optional runners and ssh2's native
# addon are built against glibc.

FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN npm install -g pnpm@10.34.5

## Workspace manifests, and nothing else, as in the server image: this layer is
## the cache key for every install below.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/docs/package.json                 apps/docs/
COPY apps/sandbox-host/package.json         apps/sandbox-host/
COPY apps/server/package.json               apps/server/
COPY apps/webapp/package.json               apps/webapp/
COPY packages/agent-core/package.json       packages/agent-core/
COPY packages/cli/package.json              packages/cli/
COPY packages/llm-tasks/package.json        packages/llm-tasks/
COPY packages/types/package.json            packages/types/
COPY packages/ui/package.json               packages/ui/
COPY tooling/eslint-config/package.json     tooling/eslint-config/
COPY tooling/typescript-config/package.json tooling/typescript-config/

FROM manifests AS dev-deps
ENV NODE_ENV=development
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --ignore-scripts --frozen-lockfile \
      --store-dir=/pnpm/store --filter=sandbox-host...

## Only Gondolin ships: the build bundles everything else into dist/main.js.
FROM manifests AS production-deps
ENV NODE_ENV=production
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --prod --frozen-lockfile \
      --store-dir=/pnpm/store --filter=sandbox-host

FROM dev-deps AS builder
COPY . .
RUN --mount=type=cache,id=turbo,target=/app/.turbo,sharing=locked \
    pnpm run build --filter=sandbox-host...

FROM node:24-bookworm-slim AS runner
ARG TARGETARCH
# The hypervisor for this architecture, and qemu-img for the guest disks.
RUN apt-get update \
 && apt-get install -y --no-install-recommends qemu-utils \
      "$([ "$TARGETARCH" = arm64 ] && echo qemu-system-arm || echo qemu-system-x86)" \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    HOME=/home/node \
    SANDBOX_HOST_BIND=0.0.0.0

COPY --from=production-deps --chown=node:node /app .
COPY --from=builder --chown=node:node /app/apps/sandbox-host/dist ./apps/sandbox-host/dist
COPY --chown=node:node apps/sandbox-host/entrypoint.sh ./apps/sandbox-host/entrypoint.sh

# Gondolin keeps its guest images here. docker-compose.yaml mounts a volume on
# it, so a restart does not download them again. The directory must exist and
# belong to node, or Docker creates the volume owned by root.
RUN mkdir -p /home/node/.cache/gondolin && chown -R node:node /home/node/.cache

EXPOSE 3004

# Starts as root only to find the group that owns /dev/kvm, then drops to node.
CMD ["sh", "apps/sandbox-host/entrypoint.sh"]
