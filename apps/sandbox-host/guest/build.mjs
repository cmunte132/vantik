// Builds the guest image that agent runs work in, and tags it
// `vantik-guest:latest` in Gondolin's local image store. The sandbox host uses
// that image when it is present. Run it again after a change to
// `build-config.json`; the new image is used from the next run.
//
// The image adds `resize2fs` (in `e2fsprogs-extra`) to the stock set, so the
// guest's root disk can grow to the run's `diskMb`. Without it, the checkout
// and its dependencies live in the guest's memory.

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
