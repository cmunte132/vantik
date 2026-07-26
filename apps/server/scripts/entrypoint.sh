#!/bin/sh
set -xe

cd /app/apps/server

# Prisma is invoked from the server's own node_modules rather than through
# `pnpm run`, so the runtime image needs no package manager installed.
export NODE_PATH='/app/node_modules/.pnpm/node_modules'

node_modules/.bin/prisma migrate deploy
node_modules/.bin/prisma generate

# This used to run `start-prod-with-prisma`, which appended `&& pnpm
# prisma:studio` after a command that never returns — Studio has therefore
# never actually started, despite the image exposing 5555 for it. Dropped
# rather than repaired: it is an unauthenticated database UI, not something to
# run alongside a production API.
exec dumb-init node dist/src/main.js
