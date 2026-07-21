#!/usr/bin/env bash

# Runtime settings used to be rewritten into the built bundle here, by seding
# every PROD_NEXT_PUBLIC_* placeholder in .next with the container's
# environment. The browser now fetches them from /api/v1/config instead, so
# there is nothing to patch and the image starts as built.

echo "Starting Nextjs"

exec dumb-init node --max-old-space-size=8192 apps/webapp/server.js
