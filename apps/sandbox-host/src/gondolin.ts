import type {
  SandboxAvailability,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxHandle,
  SandboxHostModelCalls,
  SandboxRuntime,
  SandboxSpec,
} from "@vantikhq/types";

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import {
  VM,
  createHttpHooks,
  resolveImageSelector,
} from "@earendil-works/gondolin";

import { log } from "./log";
import { ModelCallMeter } from "./meter";

/**
 * Gondolin: a microVM sandbox with a TypeScript control plane.
 *
 * Chosen for the self-hosted and development tier, where it is a large upgrade
 * over a container at near-zero integration cost. Three of its properties map
 * directly onto requirements the hosted executor already had:
 *
 * - a network stack implemented in JavaScript, so per-host egress allowlisting
 *   is programmatic rather than a container flag the guest could undo;
 * - placeholder-based secret injection that restricts a token to designated
 *   hosts — the credential-separation control, already built;
 * - qcow2 snapshots, so a two-phase setup/agent split is cheap.
 *
 * The honest caveats. Its own docs call it an early project. Taking it
 * alongside Pi concentrates two load-bearing dependencies in one young vendor.
 * QEMU/libkrun is a different bet from Firecracker or Kata. And a network
 * stack written in JavaScript is a novel, unaudited attack surface.
 *
 * So for a hosted multi-tenant tier the posture is different: keep a hardened
 * Firecracker/Kata path and treat Gondolin's egress and secret-injection
 * *design* as the pattern to reimplement rather than the code to trust. That
 * path is not built here.
 *
 * This runs in the sandbox host, never in the server. Gondolin needs QEMU and,
 * to be usable, hardware virtualisation (HVF on macOS, KVM on Linux). The
 * server often runs where neither is available, such as a container on macOS.
 */
export class GondolinRuntime implements SandboxRuntime {
  readonly name = "gondolin";

  private probed = false;
  private unavailableReason?: string;

  async availability(): Promise<SandboxAvailability> {
    this.probe();

    if (this.unavailableReason) {
      return { available: false, reason: this.unavailableReason };
    }

    return { available: true, tier: "microvm" };
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const availability = await this.availability();

    if (!availability.available) {
      // Never fall back to something weaker. An install that cannot provide
      // the boundary is refused, because a downgrade nobody was told about
      // makes the threat model on paper stop matching production.
      throw new Error(availability.reason);
    }

    const denials = { count: 0 };

    // `secrets` never reach the guest: what lands in its environment is the
    // placeholder map returned here, and the real values are substituted
    // host-side on requests to the hosts each secret names.
    const { httpHooks, env: secretEnv } = createHttpHooks({
      // An explicit list means deny-by-default. Omitting the option entirely
      // would allow everything, so an empty allowlist must still be passed.
      allowedHosts: spec.egress.allow,
      secrets: Object.fromEntries(
        Object.entries(spec.secrets).map(([name, secret]) => [
          name,
          { hosts: secret.hosts, value: secret.value },
        ]),
      ),
    });

    const image = guestImage();
    const counted = countDenials(httpHooks, denials);

    // The only secrets a guest is given are model keys, so the hosts they are
    // substituted into are the model providers, and those are the responses
    // the usage is read from. The same guard decides every connection.
    const meter = new ModelCallMeter(
      new Set(
        Object.values(spec.secrets).flatMap((secret) =>
          secret.hosts.map((host) => host.toLowerCase()),
        ),
      ),
      counted.isIpAllowed,
    );

    const vm = await VM.create({
      httpHooks: counted,
      fetch: meter.fetch,
      // Workspace paths sit underneath, so a caller that sets one of them
      // wins, and the substituted secrets win over everything.
      env: { ...workspaceEnv(), ...spec.env, ...secretEnv },
      memory: `${spec.limits.memoryMb}M`,
      cpus: spec.limits.cpus,
      // Only the Vantik image can grow its root disk: the stock image has no
      // `resize2fs`, and a size request fails its boot. The disk is sparse, so
      // `diskMb` is a ceiling on what the run writes, not space taken up front.
      ...(image
        ? {
            sandbox: { imagePath: image },
            rootfs: { size: `${spec.limits.diskMb}M` },
          }
        : {}),
      sessionLabel: `vantik-run-${spec.runId}`,
      startTimeoutMs: START_TIMEOUT_MS,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const handle = new GondolinHandle(vm, spec, denials, meter);

    try {
      // Before the files are seeded, so the run's own files land on the
      // writable area rather than under it.
      await mountWorkspace(vm, spec, Boolean(image));

      for (const [path, contents] of Object.entries(spec.files)) {
        await handle.writeFile(path, contents);
      }
    } catch (error) {
      // A guest that could not be seeded is not a guest anyone can use, and
      // leaving it running would leak a VM per failed run.
      await handle.dispose();
      throw error;
    }

    return handle;
  }

  private probe() {
    if (this.probed) {
      return;
    }
    this.probed = true;

    // Gondolin looks for QEMU only when a VM boots. Without this check the
    // sandbox host would report itself available and fail every run after its
    // checkout with `spawnSync qemu-img ENOENT`.
    const missing = missingVmmBinaries();

    if (missing.length > 0) {
      this.unavailableReason =
        `The sandbox host has no ${missing.join(" or ")} on its PATH, so it ` +
        "cannot start a sandbox. Install QEMU on the machine that runs the " +
        "sandbox host.";
    }
  }
}

/**
 * The QEMU programs that Gondolin's default backend runs, when it is the
 * backend in use. Gondolin picks the system emulator for the host's own
 * architecture, and uses `qemu-img` for the guest's disk.
 */
export function missingVmmBinaries(
  env: NodeJS.ProcessEnv = process.env,
  arch: string = process.arch,
): string[] {
  if (env.GONDOLIN_VMM && env.GONDOLIN_VMM !== "qemu") {
    return [];
  }

  const system =
    arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";

  return ["qemu-img", system].filter((name) => !onPath(name, env.PATH ?? ""));
}

function onPath(name: string, path: string): boolean {
  return path
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => {
      try {
        accessSync(join(dir, name), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

/** Long enough for a cold boot on a loaded machine; short enough to fail. */
const START_TIMEOUT_MS = 120_000;

/** The image `pnpm --filter sandbox-host build:guest` builds and tags. */
export const GUEST_IMAGE = "vantik-guest:latest";

/**
 * The directory of the Vantik guest image, or `undefined` if this machine has
 * not built it.
 *
 * Looked up for each sandbox, not once, so an image built while the sandbox
 * host runs is used from the next run. The lookup reads only the local image
 * store. It never downloads.
 */
export function guestImage(): string | undefined {
  try {
    return resolveImageSelector(GUEST_IMAGE).assetDir;
  } catch {
    return undefined;
  }
}

const WORKSPACE = "/workspace";

/**
 * Everything that writes, pointed at `/workspace`.
 *
 * `npx` fetches the harness into the npm cache, which defaults to `$HOME`, and
 * `$HOME` on the stock image is on a root filesystem with about 80MB free.
 * Pointing both here is what keeps the install on the writable area — and it
 * has a second effect worth having: the harness's own session state lands
 * outside the checkout, so it cannot turn up in the diff a reviewer reads.
 */
function workspaceEnv(): Record<string, string> {
  return {
    HOME: `${WORKSPACE}/home`,
    npm_config_cache: `${WORKSPACE}/.npm`,
    TMPDIR: `${WORKSPACE}/tmp`,
  };
}

/**
 * Gives the run somewhere to write, before it has anything to write.
 *
 * With the Vantik image, the root disk has already grown to `diskMb`, so
 * `/workspace` is an ordinary directory on it.
 *
 * The stock image has a root filesystem of about 260MB with about 80MB free,
 * and it cannot grow. The harness alone unpacks to a little over 200MB. So
 * without the Vantik image, `/workspace` is a tmpfs. That is memory: the
 * checkout, its dependencies and the harness share the RAM that the agent's
 * commands run in. A repository with a large `node_modules` fills most of it,
 * and the guest then spends its time reclaiming pages instead of running
 * tests. The sandbox host logs a warning at startup when it has only the stock
 * image.
 */
async function mountWorkspace(
  // The raw guest rather than the handle: the handle runs everything from
  // `/workspace`, which is the one directory that does not exist yet.
  vm: VM,
  spec: SandboxSpec,
  realDisk: boolean,
): Promise<void> {
  const directories = ["home", ".npm", "tmp"]
    .map((name) => `${WORKSPACE}/${name}`)
    .join(" ");

  const command = realDisk
    ? `mkdir -p ${directories}`
    : `mkdir -p ${WORKSPACE} && ` +
      `mount -t tmpfs -o size=${workspaceSizeMb(spec)}m tmpfs ${WORKSPACE} && ` +
      `mkdir -p ${directories}`;

  const result = await vm.exec(command, { cwd: "/" });

  // Refused rather than carried on with. The run would otherwise get as far as
  // fetching the harness and fail there, and "npm could not write a file" is a
  // long way from the thing that is actually wrong.
  if ((result.exitCode ?? 0) !== 0) {
    throw new Error(
      `Could not prepare a writable ${WORKSPACE} in the guest, so the ` +
        `harness would have nowhere to install: ${result.stderr}`,
    );
  }
}

/**
 * How large the tmpfs workspace may grow, when there is no Vantik image.
 *
 * Three quarters of the guest's memory, and never more than the caller asked
 * for. tmpfs charges only for what is written, so this is a ceiling rather
 * than a reservation — but it is a ceiling that has to leave the agent room to
 * run in, which `diskMb` (tens of gigabytes, written for a real disk) does not.
 */
export function workspaceSizeMb(spec: SandboxSpec): number {
  return Math.max(
    MIN_WORKSPACE_MB,
    Math.min(spec.limits.diskMb, Math.floor((spec.limits.memoryMb * 3) / 4)),
  );
}

/** Below this the harness does not fit, so there is no point starting. */
const MIN_WORKSPACE_MB = 512;

/**
 * Counts refused egress without changing what is refused.
 *
 * The policy stays Gondolin's — reimplementing host matching here would mean
 * two allowlists that can disagree. A denial spike is the clearest
 * prompt-injection signal available, so it is recorded onto the run rather
 * than dropped.
 */
function countDenials(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hooks: any,
  denials: { count: number },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const wrap =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (inner?: (argument: any) => boolean | Promise<boolean>) =>
      inner
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async (argument: any) => {
            const allowed = await inner(argument);
            if (!allowed) {
              denials.count += 1;
            }
            return allowed;
          }
        : undefined;

  return {
    ...hooks,
    isRequestAllowed: wrap(hooks.isRequestAllowed),
    isIpAllowed: wrap(hooks.isIpAllowed),
  };
}

class GondolinHandle implements SandboxHandle {
  readonly tier = "microvm" as const;

  private disposed = false;

  constructor(
    private vm: VM,
    private spec: SandboxSpec,
    private denials: { count: number },
    private meter: ModelCallMeter,
  ) {}

  get id(): string {
    return this.spec.runId;
  }

  async exec(
    command: string,
    options: SandboxExecOptions = {},
  ): Promise<SandboxExecResult> {
    const before = this.denials.count;
    const limit = this.spec.limits.maxLogBytes;

    // stdout goes to a stream rather than into a buffer, so a caller can see a
    // long command's output while it runs (the harness reports each step it
    // takes). Only the last `maxLogBytes` is kept for the result: a command
    // that writes a gigabyte should not cost a gigabyte here.
    let tail = "";
    const decoder = new StringDecoder("utf8");
    const take = (text: string) => {
      if (!text) {
        return;
      }
      tail = (tail + text).slice(-limit);
      options.onStdout?.(text);
    };
    const stdout = new Writable({
      write(chunk: Buffer, _encoding, done) {
        take(decoder.write(chunk));
        done();
      },
    });

    // A string command runs through `/bin/sh -lc`, which is what every caller
    // here wants; the array form skips the shell and does not search PATH.
    const result = await this.vm.exec(command, {
      cwd: "/workspace",
      // The runtime enforces the deadline, rather than application code that a
      // runaway process can outlive.
      signal: AbortSignal.timeout(
        options.timeoutMs ?? this.spec.limits.maxDurationMs,
      ),
      stdout,
    });

    take(decoder.end());

    return {
      exitCode: result.exitCode ?? 0,
      stdout: tail,
      stderr: String(result.stderr ?? "").slice(-limit),
      egressDenied: this.denials.count - before,
    };
  }

  modelCalls(since: number): Promise<SandboxHostModelCalls> {
    return this.meter.modelCalls(since);
  }

  readFile(path: string): Promise<string> {
    return this.vm.fs.readFile(guestPath(path), { encoding: "utf-8" });
  }

  async writeFile(path: string, contents: string): Promise<void> {
    const full = guestPath(path);
    const directory = full.slice(0, full.lastIndexOf("/"));

    if (directory) {
      await this.vm.fs.mkdir(directory, { recursive: true });
    }

    await this.vm.fs.writeFile(full, contents);
  }

  /**
   * Tears the guest down.
   *
   * Idempotent, and never throws. Cleanup runs on success, failure, cancel and
   * restart reconciliation; a throw here would mask the reason the run ended
   * and leave the machine running anyway.
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    try {
      await this.vm.close();
    } catch (error) {
      log.error(`Could not close the sandbox of run ${this.spec.runId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await this.meter.close();
  }
}

/**
 * Resolves a spec-relative path inside the guest.
 *
 * Paths in a spec are relative to `/workspace` by contract, but a `..` in one
 * would climb out of it, so anything that escapes is refused rather than
 * normalised into a different file.
 */
function guestPath(path: string): string {
  const full = `/workspace/${path}`.replace(/\/+/g, "/");

  if (full.split("/").includes("..")) {
    throw new Error(`Refusing to address a path outside /workspace: ${path}`);
  }

  return full;
}
