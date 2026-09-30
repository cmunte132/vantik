import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";

import { GUEST_IMAGE, GondolinRuntime, guestImage } from "./gondolin";
import { createSandboxHostServer } from "./http";
import { log } from "./log";
import { Sandboxes } from "./sandboxes";

loadRepoEnv();

const token = process.env.SANDBOX_HOST_TOKEN ?? "";

// Refused rather than defaulted. A sandbox host with no token, or a guessable
// one, lets anyone who can reach its port start VMs and read their files.
if (token.length < 24) {
  log.error(
    "SANDBOX_HOST_TOKEN is not set, or shorter than 24 characters. Set the same " +
      "value for the server and the sandbox host (openssl rand -hex 32).",
  );
  process.exit(1);
}

const port = Number(process.env.SANDBOX_HOST_PORT || 3004);
// Loopback by default: on a workstation only the server on the same machine
// should reach it. The container image sets 0.0.0.0.
const bind = process.env.SANDBOX_HOST_BIND || "127.0.0.1";

const runtime = new GondolinRuntime();
const sandboxes = new Sandboxes(runtime, {
  idleMs: Number(process.env.SANDBOX_HOST_IDLE_MS || 5 * 60_000),
  graceMs: Number(process.env.SANDBOX_HOST_GRACE_MS || 2 * 60_000),
});

const server = createSandboxHostServer(runtime, sandboxes, {
  token,
  maxBodyBytes:
    Number(process.env.SANDBOX_HOST_MAX_BODY_MB || 512) * 1024 * 1024,
});

// No request timeout: a checkout upload can be large on a slow link, and exec
// polls end on their own.
server.requestTimeout = 0;

const sweeper = setInterval(() => {
  void sandboxes.sweep().catch((error: unknown) => {
    log.error("The sweep failed", { error: String(error) });
  });
}, 15_000);
sweeper.unref();

server.listen(port, bind, async () => {
  const availability = await runtime.availability();

  log.info(`Listening on ${bind}:${port}`, {
    available: availability.available,
    ...(availability.reason ? { reason: availability.reason } : {}),
  });

  if (!guestImage()) {
    log.warn(
      `There is no ${GUEST_IMAGE} image, so runs use the stock image and keep ` +
        "their checkout in the guest's memory. A repository with large " +
        "dependencies can then run out of memory. To build the image, run " +
        "`pnpm --filter sandbox-host build:guest`.",
    );
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    log.info(`${signal}: disposing of every sandbox`);
    clearInterval(sweeper);
    server.close();
    await sandboxes.disposeAll("the sandbox host stopped");
    process.exit(0);
  });
}

/**
 * Reads the repository's `.env` when the sandbox host runs from a checkout,
 * so a workstation needs one file for the server and the sandbox host. A
 * variable that is already set wins.
 */
function loadRepoEnv() {
  let directory = resolve(process.cwd());

  for (;;) {
    const candidate = join(directory, ".env");

    if (
      existsSync(candidate) &&
      existsSync(join(directory, "pnpm-workspace.yaml"))
    ) {
      const values = parseEnv(readFileSync(candidate, "utf8"));

      for (const [name, value] of Object.entries(values)) {
        process.env[name] ??= value;
      }
      return;
    }

    const parent = dirname(directory);

    if (parent === directory) {
      return;
    }
    directory = parent;
  }
}
