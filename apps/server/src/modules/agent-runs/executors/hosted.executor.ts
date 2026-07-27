import { Injectable, OnModuleInit } from '@nestjs/common';
import type { AgentRun } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { LoggerService } from 'modules/logger/logger.service';

import { AgentRunsService } from '../agent-runs.service';
import { CredentialsService } from '../credentials/credentials.service';
import { GitProxyService } from '../sandbox/git-proxy.service';
import { GondolinRuntime } from '../sandbox/gondolin.runtime';
import type { SandboxHandle } from '../sandbox/sandbox.interface';
import { scrubSecrets } from '../sandbox/scrub';
import { ExecutorRegistry } from './executor.registry';
import type { AgentExecutor, ExecutorAvailability } from './executor.interface';

export const HOSTED_EXECUTOR_KEY = 'hosted';

/**
 * Hosts a run may reach. Everything else is refused and counted.
 *
 * Exported for the security spec, because "the guest cannot reach a git host"
 * is a property worth asserting rather than trusting a comment about.
 */
export function egressAllowlistForTest(
  modelBaseUrl: string | null,
): string[] {
  return egressAllowlist(modelBaseUrl);
}

function egressAllowlist(modelBaseUrl: string | null): string[] {
  return [
    // The model endpoint the workspace configured.
    ...(modelBaseUrl ? [hostOf(modelBaseUrl)] : []),
    // Package registries, because a setup phase that cannot install is a
    // setup phase that always fails.
    'registry.npmjs.org',
    'pypi.org',
    'files.pythonhosted.org',
    // Deliberately absent: the git host. The guest never pushes — the host
    // does, on its behalf — so it has no reason to reach one, and an attempt
    // to is a signal rather than a need.
  ].filter(Boolean);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Runs an agent on Vantik infrastructure, with credentials the workspace
 * supplied once.
 *
 * The value-add over the BYO runner is that there is nothing to keep alive.
 * The cost is that Vantik now holds a model key and a git token, which is what
 * the whole design around this executor is arranged to contain:
 *
 * - the git token never enters the guest — push and PR happen host-side;
 * - the guest runs in a microVM, never a plain container, and an install that
 *   cannot provide one is refused rather than downgraded;
 * - setup and agent phases are separate, so install-time network and secrets
 *   exist only in the first;
 * - egress is an allowlist the guest cannot reconfigure, and denials are
 *   recorded because a spike is the clearest injection signal available.
 */
@Injectable()
export class HostedExecutor implements AgentExecutor, OnModuleInit {
  readonly key = HOSTED_EXECUTOR_KEY;
  readonly label = 'Vantik hosted sandbox';

  private readonly logger = new LoggerService('HostedExecutor');

  /** Live guests, so cancel can actually kill one. */
  private readonly running = new Map<string, SandboxHandle>();

  constructor(
    private registry: ExecutorRegistry,
    private runtime: GondolinRuntime,
    private credentials: CredentialsService,
    private gitProxy: GitProxyService,
    private agentRuns: AgentRunsService,
    private prisma: PrismaService,
  ) {}

  async onModuleInit() {
    this.registry.register(this);
    await this.reconcileAfterRestart();
  }

  /**
   * Whether this workspace can use hosted execution, and if not, why.
   *
   * Both halves are gates the user can act on: a missing runtime is an
   * install problem, missing credentials are a settings page.
   */
  async availability(workspaceId: string): Promise<ExecutorAvailability> {
    const runtime = await this.runtime.availability();

    if (!runtime.available) {
      return {
        available: false,
        reason:
          runtime.reason ??
          'This server cannot provide a sandbox, so hosted execution is unavailable. Use the BYO runner instead.',
      };
    }

    if (!(await this.credentials.has(workspaceId, 'MODEL_API_KEY'))) {
      return {
        available: false,
        reason:
          'This workspace has no model API key configured. Add one in Settings → Agents before using hosted execution.',
      };
    }

    return { available: true };
  }

  /**
   * Push-based: the work starts here rather than waiting to be claimed.
   *
   * Deliberately not awaited into the caller's request — a sandbox run takes
   * minutes and the delegating HTTP call must return immediately. The failure
   * path lands on the run record, never as a dropped promise.
   */
  async dispatch(run: AgentRun): Promise<void> {
    void this.execute(run).catch((error) => {
      this.logger.error({
        message: `Hosted run ${run.id} failed outside its own handler: ${error}`,
        where: 'HostedExecutor.dispatch',
        error: error instanceof Error ? error : undefined,
      });
    });
  }

  /** Cancel has to kill the machine, not just mark the row. */
  async cancel(run: AgentRun): Promise<void> {
    const sandbox = this.running.get(run.id);

    if (!sandbox) {
      return;
    }

    await sandbox.dispose();
    this.running.delete(run.id);
  }

  private async execute(run: AgentRun): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = (run.config ?? {}) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pack = (run.contextPack ?? {}) as any;

    const model = await this.credentials.reveal(run.workspaceId, 'MODEL_API_KEY');

    if (!model) {
      await this.fail(run, 'ENVIRONMENT_SETUP_FAILED', 'No model key is configured.');
      return;
    }

    const secrets = [model.secret];
    let sandbox: SandboxHandle | undefined;
    let egressDenied = 0;

    const note = async (message: string, phase: string) => {
      // Scrubbed before it is written, not after. An event row is read by a
      // human and replicated to every connected client.
      await this.agentRuns
        .appendEvent(
          run.id,
          { message: scrubSecrets(message, secrets), phase },
          { workspaceId: run.workspaceId },
        )
        .catch((): undefined => undefined);
    };

    try {
      await this.agentRuns.transition(run.id, 'CLAIMED', {
        claimedAt: new Date(),
      });

      sandbox = await this.runtime.create({
        runId: run.id,
        files: {
          // The context pack goes in as a file rather than an argument, so it
          // never appears in a process listing the guest can read.
          'context.json': JSON.stringify(pack, null, 2),
        },
        env: {
          ...(model.baseUrl ? { LLM_BASE_URL: model.baseUrl } : {}),
        },
        secrets: {
          // The guest gets a placeholder under this name; the runtime swaps
          // the real key in on requests to the model host and nowhere else.
          // So the agent can call the model, and an agent that dumps its
          // whole environment dumps nothing worth having.
          //
          // There is no git token here and no code path that would add one:
          // pushing happens host-side, so the guest holds neither the token
          // nor a placeholder for it.
          LLM_API_KEY: {
            value: model.secret,
            hosts: model.baseUrl ? [hostOf(model.baseUrl)] : [],
          },
        },
        limits: {
          maxDurationMs: config.limits?.maxDurationMs ?? 30 * 60 * 1000,
          memoryMb: 4096,
          diskMb: 20480,
          cpus: 2,
          maxLogBytes: 256 * 1024,
        },
        egress: { allow: egressAllowlist(model.baseUrl) },
      });

      this.running.set(run.id, sandbox);

      // ---- Phase 1: setup. Network and install credentials present. ----
      await note('Preparing the sandbox', 'setup');

      const cloneUrl = config.repoUrl;
      if (!cloneUrl) {
        await this.fail(
          run,
          'ENVIRONMENT_SETUP_FAILED',
          'Hosted execution needs a repo url to clone; this run has none.',
        );
        return;
      }

      // Cloned by the host and seeded in, so the guest never holds a
      // credential that could reach the git host — and never needs to reach
      // one, which is why no git host is on its allowlist.
      let checkout;
      try {
        checkout = await this.gitProxy.materializeCheckout({
          workspaceId: run.workspaceId,
          repoUrl: cloneUrl,
          baseBranch: config.baseBranch ?? 'main',
        });
      } catch (error) {
        await this.fail(
          run,
          'ENVIRONMENT_SETUP_FAILED',
          scrubSecrets(
            error instanceof Error ? error.message : String(error),
            secrets,
          ),
          egressDenied,
        );
        return;
      }

      await sandbox.writeFile('repo.tar.gz.b64', checkout.archiveBase64);

      const unpack = await sandbox.exec(
        'mkdir -p /workspace/repo && ' +
          'base64 -d /workspace/repo.tar.gz.b64 | tar xz -C /workspace/repo && ' +
          'rm -f /workspace/repo.tar.gz.b64',
      );
      egressDenied += unpack.egressDenied;

      if (unpack.exitCode !== 0) {
        await this.fail(
          run,
          'ENVIRONMENT_SETUP_FAILED',
          scrubSecrets(unpack.stderr, secrets),
          egressDenied,
        );
        return;
      }

      for (const command of config.setupCommands ?? []) {
        const result = await sandbox.exec(`cd /workspace/repo && ${command}`);
        egressDenied += result.egressDenied;

        if (result.exitCode !== 0) {
          await this.fail(
            run,
            'ENVIRONMENT_SETUP_FAILED',
            scrubSecrets(`${command}\n${result.stderr}`, secrets),
            egressDenied,
          );
          return;
        }
      }

      // Recorded host-side, from the clone the host made. Asking the guest
      // would be asking the thing under test what it was given.
      const baseCommit = checkout.baseCommit;


      await this.agentRuns.transition(run.id, 'RUNNING', {
        startedAt: new Date(),
        baseCommit,
      });

      // ---- Phase 2: agent. Reduced egress, no install credentials. ----
      await note('Running the agent', 'implement');

      // `--no-extensions` is a security control, not a preference: Pi
      // auto-discovers extensions from `.pi/extensions/*.ts` in the project
      // directory and runs them with full access, which for an agent pointed
      // at arbitrary repositories is a code-execution path the repository
      // controls.
      //
      // A configured harness command replaces it, which is how a deployment
      // runs something other than Pi — and how this path is exercised without
      // spending model credits.
      const harness =
        config.harnessCommand ??
        'npx --yes @earendil-works/pi-coding-agent --mode rpc --no-extensions --no-approve';

      const agent = await sandbox.exec(
        `cd /workspace/repo && ${harness} < /workspace/context.json`,
        { timeoutMs: config.limits?.maxDurationMs ?? 30 * 60 * 1000 },
      );
      egressDenied += agent.egressDenied;

      if (agent.exitCode !== 0) {
        await this.fail(
          run,
          'HARNESS_CRASHED',
          scrubSecrets(agent.stderr, secrets),
          egressDenied,
        );
        return;
      }

      // The tree comes back as an archive rather than a patch: the guest has
      // no git, and asking it to describe its own changes would be asking the
      // thing under test what it did. The host compares it against the base it
      // cloned.
      const packed = await sandbox.exec(
        'tar czf /tmp/tree.tar.gz -C /workspace/repo . && ' +
          'base64 /tmp/tree.tar.gz > /workspace/tree.b64 && ' +
          'rm -f /tmp/tree.tar.gz',
      );
      egressDenied += packed.egressDenied;

      if (packed.exitCode !== 0) {
        await this.fail(
          run,
          'HARNESS_CRASHED',
          `The sandbox produced no readable working tree: ${scrubSecrets(
            packed.stderr,
            secrets,
          )}`,
          egressDenied,
        );
        return;
      }

      // BusyBox `base64` wraps its output; the decoder does not care, but the
      // newlines would otherwise travel all the way into a Buffer conversion.
      const treeBase64 = (await sandbox.readFile('tree.b64')).replace(
        /\s+/g,
        '',
      );

      // ---- Handback: host-side, with a credential the guest never held. ----
      await note('Pushing the branch', 'report');

      const pushed = await this.gitProxy.pushWorkTree({
        workspaceId: run.workspaceId,
        repoUrl: cloneUrl,
        branch: `agent/${String(pack.issue?.key ?? run.issueId).toLowerCase()}`,
        treeBase64,
        baseCommit,
        commitMessage: `${pack.issue?.key ?? ''}: ${pack.issue?.title ?? 'Agent work'}`,
        issueKey: pack.issue?.key ?? run.issueId,
        issueTitle: pack.issue?.title ?? 'Agent work',
        summary: 'Opened by a Vantik agent running in a hosted sandbox.',
      });

      if (!pushed) {
        await this.fail(
          run,
          'NO_DIFF_PRODUCED',
          'The agent changed nothing.',
          egressDenied,
        );
        return;
      }

      await this.agentRuns.transition(run.id, 'SUCCEEDED', {
        summary: 'Finished in a hosted sandbox.',
        result: {
          delivery: 'pull_request',
          branch: pushed.branch,
          prUrl: pushed.prUrl,
          headCommit: pushed.headCommit,
          egressDenied,
        },
      });
    } catch (error) {
      // Where it broke decides what the user is told to do. Everything before
      // the agent phase is the environment — a guest that would not boot is
      // not a crashed agent, and calling it one sends someone to read a
      // harness log that does not exist. A refused push is neither: the work
      // exists and the remote would not take it, which is a different thing to
      // go and fix.
      const message = error instanceof Error ? error.message : String(error);

      await this.fail(
        run,
        /\[rejected\]|non-fast-forward|protected branch|denying/i.test(message)
          ? 'PUSH_REJECTED'
          : sandbox
            ? 'HARNESS_CRASHED'
            : 'ENVIRONMENT_SETUP_FAILED',
        scrubSecrets(message, secrets),
        egressDenied,
      );
    } finally {
      // Always. On success, on failure, on cancel — the VM, the checkout and
      // the decrypted key all go.
      await sandbox?.dispose();
      this.running.delete(run.id);
    }
  }

  private async fail(
    run: AgentRun,
    failure:
      | 'ENVIRONMENT_SETUP_FAILED'
      | 'HARNESS_CRASHED'
      | 'NO_DIFF_PRODUCED'
      | 'PUSH_REJECTED',
    error: string,
    egressDenied = 0,
  ) {
    await this.agentRuns
      .transition(run.id, 'FAILED', {
        failure,
        error: error.slice(0, 4000),
        result: { egressDenied },
      })
      .catch((): undefined => undefined);
  }

  /**
   * After a restart, no sandbox this process was tracking still exists.
   *
   * Any hosted run left CLAIMED or RUNNING is therefore orphaned: its guest
   * died with the old process and nothing will ever report on it. Left alone
   * it would sit until its lease expired, which is correct but slow. Failing
   * it explicitly tells the user what happened.
   */
  private async reconcileAfterRestart() {
    const orphans = await this.prisma.agentRun.findMany({
      where: {
        executor: HOSTED_EXECUTOR_KEY,
        status: { in: ['CLAIMED', 'RUNNING'] },
        deleted: null,
      },
      select: { id: true },
    });

    for (const orphan of orphans) {
      await this.agentRuns
        .transition(orphan.id, 'FAILED', {
          failure: 'HARNESS_CRASHED',
          error:
            'The server restarted while this run was in a sandbox, so the sandbox was lost. Retry it.',
        })
        .catch((): undefined => undefined);
    }

    if (orphans.length > 0) {
      this.logger.info({
        message: `Failed ${orphans.length} hosted run(s) orphaned by a restart`,
        where: 'HostedExecutor.reconcileAfterRestart',
      });
    }
  }
}

// A `shellSafe` guard used to sit here, for the repo url and base branch that
// were interpolated into the guest's `git clone`. Both now go to host-side git
// as argv rather than through a shell, so there is no interpolation left to
// guard — the escaping problem was removed rather than solved.
