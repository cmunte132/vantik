import { Injectable } from '@nestjs/common';

import { LoggerService } from 'modules/logger/logger.service';

import type {
  SandboxAvailability,
  SandboxExecResult,
  SandboxHandle,
  SandboxRuntime,
  SandboxSpec,
} from './sandbox.interface';

/**
 * Gondolin: a microVM sandbox with a TypeScript control plane.
 *
 * Chosen for the self-hosted and development tier, where it is a large upgrade
 * over a container at near-zero integration cost. Three of its properties map
 * directly onto requirements this issue already had:
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
 * path is not built here, and this runtime reports itself unavailable rather
 * than pretending otherwise when the package is absent.
 *
 * Loaded by dynamic import on purpose: it is an optional dependency, and a
 * server that does not offer hosted execution should not fail to start because
 * a sandbox package is missing. The import resolves the package's ESM entry
 * explicitly — the `require` condition points at a CommonJS build whose
 * exports arrive namespaced under `default`, which silently yields a module
 * with no `VM` on it.
 */
@Injectable()
export class GondolinRuntime implements SandboxRuntime {
  readonly name = 'gondolin';

  private readonly logger = new LoggerService('GondolinRuntime');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private module: any;
  private probed = false;
  private unavailableReason?: string;

  async availability(): Promise<SandboxAvailability> {
    await this.load();

    if (!this.module) {
      return {
        available: false,
        reason:
          this.unavailableReason ??
          'The @earendil-works/gondolin package is not installed, so this ' +
            'server cannot provide a microVM. Install it to enable hosted ' +
            'execution, or use the BYO runner.',
      };
    }

    return { available: true, tier: 'microvm' };
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
    const { httpHooks, env: secretEnv } = this.module.createHttpHooks({
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

    const vm = await this.module.VM.create({
      httpHooks: countDenials(httpHooks, denials),
      env: { ...spec.env, ...secretEnv },
      memory: `${spec.limits.memoryMb}M`,
      cpus: spec.limits.cpus,
      // Growing the root disk needs `resize2fs` *inside* the guest, which the
      // stock Alpine image does not carry — asking for it there fails the boot
      // outright. So the disk cap is the guest image's own size unless a
      // deployment has built an image that can resize and says so. Memory,
      // cpu, wall-clock and log volume are enforced regardless.
      ...(rootfsSizeMb() ? { rootfs: { size: `${rootfsSizeMb()}M` } } : {}),
      sessionLabel: `vantik-run-${spec.runId}`,
      startTimeoutMs: START_TIMEOUT_MS,
    });

    const handle = new GondolinHandle(vm, spec, this.logger, denials);

    try {
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

  private async load() {
    if (this.probed) {
      return;
    }
    this.probed = true;

    try {
      const packageJson = require.resolve(
        '@earendil-works/gondolin/package.json',
      );
      const entry = new URL(
        './dist/src/index.js',
        `file://${packageJson}`,
      ).href;

      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      this.module = await (Function(
        'entry',
        'return import(entry)',
      )(entry) as Promise<unknown>);
    } catch (error) {
      this.unavailableReason =
        `The sandbox runtime could not be loaded: ${
          error instanceof Error ? error.message : String(error)
        }. Hosted execution is unavailable on this server; the BYO runner ` +
        'still works.';
    }
  }
}

/** Long enough for a cold boot on a loaded machine; short enough to fail. */
const START_TIMEOUT_MS = 120_000;

/**
 * The root disk size to ask the guest for, if any.
 *
 * Opt-in because it is only honoured by a guest image that ships `resize2fs`;
 * with the stock image, requesting a size fails the boot rather than being
 * ignored. A deployment that has built its own image sets
 * `VANTIK_SANDBOX_ROOTFS_MB` and gets the cap.
 */
function rootfsSizeMb(): number | undefined {
  const configured = Number(process.env.VANTIK_SANDBOX_ROOTFS_MB);

  return Number.isFinite(configured) && configured > 0 ? configured : undefined;
}

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? async (argument: any) => {
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
  readonly tier = 'microvm' as const;

  private disposed = false;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private vm: any,
    private spec: SandboxSpec,
    private logger: LoggerService,
    private denials: { count: number },
  ) {}

  get id(): string {
    return this.spec.runId;
  }

  async exec(
    command: string,
    options: { timeoutMs?: number } = {},
  ): Promise<SandboxExecResult> {
    const before = this.denials.count;

    // A string command runs through `/bin/sh -lc`, which is what every caller
    // here wants; the array form skips the shell and does not search PATH.
    const result = await this.vm.exec(command, {
      cwd: '/workspace',
      // The runtime enforces the deadline, rather than application code that a
      // runaway process can outlive.
      signal: AbortSignal.timeout(
        options.timeoutMs ?? this.spec.limits.maxDurationMs,
      ),
    });

    return {
      exitCode: result.exitCode ?? 0,
      // Capped here as well as in the runtime: a command that writes a
      // gigabyte of output should cost memory once, not twice.
      stdout: String(result.stdout ?? '').slice(-this.spec.limits.maxLogBytes),
      stderr: String(result.stderr ?? '').slice(-this.spec.limits.maxLogBytes),
      egressDenied: this.denials.count - before,
    };
  }

  readFile(path: string): Promise<string> {
    return this.vm.fs.readFile(guestPath(path), { encoding: 'utf-8' });
  }

  async writeFile(path: string, contents: string): Promise<void> {
    const full = guestPath(path);
    const directory = full.slice(0, full.lastIndexOf('/'));

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
      this.logger.error({
        message: `Could not close sandbox ${this.spec.runId}: ${error}`,
        where: 'GondolinHandle.dispose',
        error: error instanceof Error ? error : undefined,
      });
    }
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
  const full = `/workspace/${path}`.replace(/\/+/g, '/');

  if (full.split('/').includes('..')) {
    throw new Error(`Refusing to address a path outside /workspace: ${path}`);
  }

  return full;
}
