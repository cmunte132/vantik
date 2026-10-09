#!/usr/bin/env bash
# Builds the images from this checkout and restarts the stack on them.
#
#   pnpm stack:rebuild               # server and webapp
#   pnpm stack:rebuild webapp        # one image
#
# Use this, not `compose up -d --build`, for three reasons:
#
# - podman-compose starts every image build at the same time. The server's
#   install and tsc run next to the webapp's install and vite build, and the
#   total does not fit in a 2 GiB podman VM. This script builds one image at a
#   time.
# - Each build leaves the stages of the previous image as untagged images, and
#   nothing removes them. One build on a new VM left 7.5 GB. This script prunes
#   them when it exits, whether the build worked or not. It prunes only images
#   that carry the label below, and only those older than a set age, so the
#   same-day rebuilds still find their layers in the cache. The VM may hold
#   images of other projects, and this script never touches those.
# - A build writes several GB, and a full VM wedges. This script stops before it
#   stops the stack when the VM has less free space than a build needs.
# - The running stack holds about 800 MB, and the webapp's vite build needs
#   about 900 MB. Beside each other they do not fit in 2 GiB, so this script
#   stops the stack while it builds, which takes a minute or two. If a build
#   fails, the stack starts again on the images it had.
# - `up -d --build` can keep a container on its old image. This script
#   recreates the containers of the images it built.
#
# Settings, all optional:
#
#   VANTIK_MIN_FREE_GB     Free space the VM needs before a build. Default 10.
#                          0 turns the check off.
#   VANTIK_PRUNE_AFTER_HOURS
#                          Age at which an unused build layer is removed.
#                          Default 72.
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

# Every stage of both Dockerfiles carries this label. It is the only thing the
# prune below selects on.
build_label=org.vantik.build=true

min_free_gb=${VANTIK_MIN_FREE_GB:-10}
prune_after_hours=${VANTIK_PRUNE_AFTER_HOURS:-72}

# Free space, in KiB, where the images are stored. Prints nothing when this
# script cannot tell, and the check is then skipped.
free_kib() {
  local root
  if [ "$cli" = podman ]; then
    if [ "$(uname -s)" = Darwin ]; then
      # Podman on macOS keeps the images inside the VM, not on this disk.
      podman machine ssh df -Pk /var 2>/dev/null | awk 'END { print $4 }'
      return
    fi
    root=$(podman info --format '{{.Store.GraphRoot}}' 2>/dev/null) || return 0
  else
    # Docker Desktop keeps the images inside a VM this script cannot read.
    root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null) || return 0
    [ -d "$root" ] || return 0
  fi
  df -Pk "$root" 2>/dev/null | awk 'END { print $4 }'
}

if [ "$min_free_gb" -gt 0 ]; then
  free=$(free_kib || true)
  if [ -n "${free:-}" ] && [ "$free" -lt $((min_free_gb * 1024 * 1024)) ]; then
    echo "The image store has $((free / 1024 / 1024)) GB free, and a build needs about $min_free_gb GB." >&2
    echo "Nothing was stopped. Free space first (remove images you no longer use)," >&2
    echo "or set VANTIK_MIN_FREE_GB=0 to build anyway." >&2
    exit 1
  fi
fi

# Removes unused layers of earlier Vantik builds once they are old enough.
# Without -a this removes only untagged images, so no image that a container or
# a tag still names is touched, and the label keeps it to this project.
prune_old_layers() {
  "$cli" image prune -f \
    --filter "label=$build_label" \
    --filter "until=${prune_after_hours}h" >/dev/null 2>&1 || true
}

stopped=0
on_exit() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$stopped" -eq 1 ]; then
    echo "==> Build failed; starting the stack on its old images"
    "$cli" compose up -d --no-build || true
  fi
  prune_old_layers
  exit "$status"
}
trap on_exit EXIT

echo "==> Stopping the stack for the build"
stopped=1
"$cli" compose stop

for service in "${services[@]}"; do
  echo "==> Building $service ($VANTIK_BUILD_ID)"
  "$cli" compose build "$service"
done

stopped=0

echo "==> Starting the stack"
"$cli" compose up -d --no-build
"$cli" compose up -d --no-build --no-deps --force-recreate "${services[@]}"
