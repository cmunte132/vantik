#!/usr/bin/env bash
# Builds the images from this checkout and restarts the stack on them.
#
#   pnpm stack:rebuild               # server and webapp
#   pnpm stack:rebuild webapp        # one image
#
# Use this, not `compose up -d --build`, for three reasons:
#
# - podman-compose starts every image build at the same time. The server's
#   install and tsc run next to the webapp's install and next build, and the
#   total does not fit in a 2 GiB podman VM. This script builds one image at a
#   time.
# - Each build leaves the stages of the previous image as untagged images, and
#   nothing removes them. One build on a new VM left 7.5 GB. This script prunes
#   them after each image.
# - `up -d --build` can keep a container on its old image. This script
#   recreates the containers of the images it built.
set -euo pipefail

cd "$(dirname "$0")/.."

if command -v podman >/dev/null 2>&1; then
  cli=podman
else
  cli=docker
fi

services=("$@")
if [ ${#services[@]} -eq 0 ]; then
  services=(server webapp)
fi

# The build stamp. .git is not in the build context, so it comes from here.
VANTIK_BUILD_ID=${VANTIK_BUILD_ID:-$(git rev-parse --short HEAD)}
VANTIK_COMMIT=${VANTIK_COMMIT:-$(git rev-parse HEAD)}
export VANTIK_BUILD_ID VANTIK_COMMIT

for service in "${services[@]}"; do
  echo "==> Building $service ($VANTIK_BUILD_ID)"
  "$cli" compose build "$service"
  "$cli" image prune -f >/dev/null
done

echo "==> Starting the stack"
"$cli" compose up -d --no-build
"$cli" compose up -d --no-build --no-deps --force-recreate "${services[@]}"
