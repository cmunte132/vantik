// Builds the guest image that agent runs work in, and tags it
// `vantik-guest:latest` in Gondolin's local image store. The sandbox host uses
// that image when it is present. Run it again after a change to
// `build-config.json`; the new image is used from the next run.
//
// The image adds `resize2fs` (in `e2fsprogs-extra`) to the stock set, so the
// guest's root disk can grow to the run's `diskMb`. Without it, the checkout
// and its dependencies live in the guest's memory.
//
// It also bakes in Pi, at the version the server pins, and the code tools the
// agent is given: TypeScript and Python language servers, ast-grep, fd and
// jq. Nothing a run needs is fetched at run time when the image is current.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  readFileSync(join(here, "build-config.json"), "utf8"),
);

config.arch = process.arch === "arm64" ? "aarch64" : "x86_64";

// The Pi the server asks for, read from where the server reads it, so the
// image cannot bake a different one. A run checks /opt/vantik/pi-version and
// fetches Pi itself when they differ, so a stale image is slow, not wrong.
const harness = readFileSync(
  join(here, "../../../packages/types/src/agent-run/harness.ts"),
  "utf8",
);
const piVersion = /export const PI_VERSION = '([^']+)'/.exec(harness)?.[1];
if (!piVersion || !/^[\w.-]+$/.test(piVersion)) {
  console.error("Could not read PI_VERSION from packages/types.");
  process.exit(1);
}
config.postBuild.commands = config.postBuild.commands.map((command) =>
  command.replaceAll("${PI_VERSION}", piVersion),
);

// macOS has no `mke2fs`, so Gondolin builds the filesystem in a container.
// Linux builds it directly, which needs e2fsprogs on the machine.
if (process.platform === "darwin") {
  config.container = { force: true };
}

const scratch = mkdtempSync(join(tmpdir(), "vantik-guest-"));
const configPath = join(scratch, "build-config.json");
writeFileSync(configPath, JSON.stringify(config, null, 2));

const result = spawnSync(
  "gondolin",
  ["build", "--config", configPath, "--tag", "vantik-guest:latest"],
  { stdio: "inherit" },
);

rmSync(scratch, { recursive: true, force: true });
process.exit(result.status ?? 1);
