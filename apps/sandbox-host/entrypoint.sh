#!/bin/sh
# Runs the sandbox host as node, with access to /dev/kvm when it is present.
#
# The group that owns /dev/kvm has a different id on each Linux distribution,
# and the image cannot know it. So the entrypoint starts as root, reads the id
# from the device, and gives node that one extra group. Nothing else runs as
# root.
set -e

cd /app/apps/sandbox-host

if [ -e /dev/kvm ]; then
  exec setpriv --reuid=node --regid=node --groups="$(stat -c %g /dev/kvm)" \
    --inh-caps=-all node dist/main.js
fi

# Without /dev/kvm, QEMU falls back to emulation. Runs are then very slow, but
# they still run inside a VM.
echo "No /dev/kvm in this container. Sandboxes will run without hardware virtualisation." >&2
exec setpriv --reuid=node --regid=node --clear-groups --inh-caps=-all node dist/main.js
