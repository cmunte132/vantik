import type { AgentExecutor, ExecutorAvailability } from './executor.interface';
import type { SandboxHandle } from '../sandbox/sandbox.interface';
import type { AgentRun } from '@prisma/client';

import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  PI_PACKAGE,
  PI_REQUIRED_FLAGS,
  THINKING_LEVELS,
  isSafeModelId,
  providerById,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { LoggerService } from 'modules/logger/logger.service';

import { AgentRunsService } from '../agent-runs.service';
import { ExecutorRegistry } from './executor.registry';
import { CredentialsService } from '../credentials/credentials.service';
import { GitProxyService } from '../sandbox/git-proxy.service';
import { GondolinRuntime } from '../sandbox/gondolin.runtime';
import { RunHandbackService } from '../run-handback.service';
import { buildAgentPrompt } from '../agent-prompt';
import { skillArguments, skillFiles } from '../agent-skills';
import { parsePiEvents } from './pi-events';
import { scrubSecrets } from '../sandbox/scrub';

export const HOSTED_EXECUTOR_KEY = 'hosted';

/**
 * Hosts a run may reach. Everything else is refused and counted.
 *
 * Exported for the security spec, because "the guest cannot reach a git host"
 * is a property worth asserting rather than trusting a comment about.
 */
export function egressAllowlistForTest(
  modelHost: string | null,
  moduleHosts: string[] = [],
): string[] {
  return egressAllowlist(modelHost, moduleHosts);
}

/**
 * The host this provider's traffic goes to.
 *
 * The provider's fixed host, unless the workspace configured an endpoint of
 * its own — which is how Azure works, where every customer has a different
 * one. Getting this wrong does not leak anything, but it does block the
 * model call: the sandbox denies egress to everything not on the list.
 */
function modelHost(provider: { host: string }, baseUrl: string | null): string {
  return baseUrl ? hostOf(baseUrl) : provider.host;
}

/**
 * The bundled harness invocation, for this run.
 *
 * Built from parts rather than written as a string so the required security
 * flags cannot be dropped by an edit to the model options beside them, and so
 * the package stays pinned to the version recorded on the run.
 *
 * Ids are validated rather than escaped. This string is executed by a shell in
 * the sandbox, and `config.model` arrives from whoever delegated — so a value
 * outside the safe set is dropped, not quoted. Dropping it costs a run its
 * model preference; getting the quoting subtly wrong costs command execution.
 */
export function piCommand(options: {
  provider?: string;
  model?: string;
  thinking?: string;
  /** Absolute guest paths. Additive even under `--no-skills`. */
  skills?: string[];
}): string {
  const args = ['npx', '--yes', PI_PACKAGE, ...PI_REQUIRED_FLAGS];

  // Explicit, because discovery is off. `--no-skills` stops Pi reading skills
  // out of the checkout — where they would be instructions written by whoever
  // can land a file in the repository — and `--skill` still loads the ones we
  // chose, which is the same shape as `--no-extensions`.
  for (const skill of options.skills ?? []) {
    args.push('--skill', skill);
  }

  if (options.provider && isSafeModelId(options.provider)) {
    args.push('--provider', options.provider);
  }

  if (options.model && isSafeModelId(options.model)) {
    args.push('--model', options.model);
  }

  // Checked against the list rather than passed through: Pi rejects a level it
  // does not know, and a run that dies on a typo in a settings field is a poor
  // way to find out about it.
  if (
    options.thinking &&
    (THINKING_LEVELS as readonly string[]).includes(options.thinking)
  ) {
    args.push('--thinking', options.thinking);
  }

  return args.join(' ');
}

function egressAllowlist(
  modelHost: string | null,
  moduleHosts: string[] = [],
): string[] {
  return [
    // The provider this run calls, and only that one.
    ...(modelHost ? [modelHost] : []),
    // npm, unconditionally: the harness itself is fetched with `npx`, so a run
    // that cannot reach the npm registry has no agent at all.
    'registry.npmjs.org',
    // What this run's module declared, and nothing else. The module already
    // owns how it installs itself; this is the half of that statement a
    // command string cannot make. A Go module names the Go proxy here; a pnpm
    // one names nothing and gets nothing extra.
    ...moduleHosts,
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
    private handback: RunHandbackService,
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

    // A deployment that supplies its own key makes hosted execution available
    // to a workspace that has brought nothing, so this asks where the key comes
    // from rather than whether the workspace owns one.
    if ((await this.credentials.modelAccess(workspaceId)).source === 'none') {
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

    // The provider the run asked for, or the workspace's only one. A workspace
    // holding keys for several providers and a run that named none is refused
    // rather than resolved: choosing would spend their money at a company they
    // did not pick for this run.
    const model = await this.credentials.revealModelKey(
      run.workspaceId,
      config.provider,
    );

    if (!model) {
      await this.fail(
        run,
        'ENVIRONMENT_SETUP_FAILED',
        config.provider
          ? `This workspace has no ${config.provider} key configured.`
          : 'No model key is configured, or more than one provider is set up and this run named none.',
      );
      return;
    }

    const provider = providerById(model.provider);

    if (!provider) {
      // The stored provider is not one this build knows. Refusing beats
      // guessing an environment variable: the key would reach the harness
      // under a name it does not read, and the run would fail later with a
      // model error that says nothing about the real cause.
      await this.fail(
        run,
        'ENVIRONMENT_SETUP_FAILED',
        `This workspace's model key is for "${model.provider}", which this version does not know how to run.`,
      );
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

      // ---- Phase 0: the checkout, host-side, before anything boots. ----
      //
      // Ordered ahead of the guest deliberately. The egress allowlist is fixed
      // at VM creation and cannot be widened afterwards, and what a run is
      // allowed to reach depends on the toolchain its module needs — so the
      // checkout has to exist before the machine does. It also means a run
      // that could never proceed no longer pays for a microVM first: the
      // repository check below used to run after a boot.
      await note('Fetching the repository', 'setup');

      // A path is as good a remote as a URL. `git clone` takes either, the
      // proxy already declines to demand a credential for one, and its own
      // reasoning says the local and self-hosted setups are the ones hosted
      // execution should serve first. Insisting on a URL here contradicted
      // that: a workspace whose modules point at a repository on this disk —
      // which is what the local-repo integration produces — could not run a
      // single issue in the sandbox.
      const cloneUrl = config.repoUrl ?? config.repoPath;
      if (!cloneUrl) {
        await this.fail(
          run,
          'ENVIRONMENT_SETUP_FAILED',
          'This run has no repository to open. Point the issue\u2019s modules at ' +
            'one, or set a default in Settings \u2192 Agents.',
        );
        return;
      }

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
        );
        return;
      }

      sandbox = await this.runtime.create({
        runId: run.id,
        files: {
          // The prompt goes in as a file rather than an argument, so it never
          // appears in a process listing the guest can read — and so nothing
          // from an issue body is ever interpolated into a shell command.
          'prompt.md': buildAgentPrompt(pack),
          // The pack itself, for the record. Nothing reads it; it is here so
          // that "what was this run given" is answerable from inside a guest
          // somebody is debugging.
          'context.json': JSON.stringify(pack, null, 2),
          // What the agent knows before it reads the repository: how to read a
          // Vantik issue, and how to write a change worth reviewing.
          ...skillFiles(),
        },
        env: {
          // The provider's own variable, for the providers that have one.
          // There is no generic base-url variable Pi reads.
          ...(model.baseUrl && provider.baseUrl
            ? { [provider.baseUrl.envVar]: model.baseUrl }
            : {}),
        },
        secrets: {
          // Under the exact name this provider's SDK reads — ANTHROPIC_API_KEY,
          // OPENAI_API_KEY, GEMINI_API_KEY and so on. Pi has no generic key
          // variable, so a name of our own choosing authenticates nothing.
          //
          // The guest gets a placeholder under it; the runtime swaps the real
          // key in on requests to the model host and nowhere else. So the
          // agent can call the model, and an agent that dumps its whole
          // environment dumps nothing worth having.
          //
          // There is no git token here and no code path that would add one:
          // pushing happens host-side, so the guest holds neither the token
          // nor a placeholder for it.
          [provider.envVar]: {
            value: model.secret,
            hosts: [modelHost(provider, model.baseUrl)].filter(Boolean),
          },
        },
        limits: {
          maxDurationMs: config.limits?.maxDurationMs ?? 30 * 60 * 1000,
          memoryMb: 4096,
          diskMb: 20480,
          cpus: 2,
          maxLogBytes: 256 * 1024,
        },
        // Base hosts plus exactly what this module declared. A Go module opens
        // the Go proxy; a pnpm one does not.
        egress: {
          allow: egressAllowlist(
            modelHost(provider, model.baseUrl),
            config.egressHosts,
          ),
        },
      });

      this.running.set(run.id, sandbox);

      // ---- Phase 1: setup. Network and install credentials present. ----
      await note('Preparing the sandbox', 'setup');

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

      // A configured harness command replaces the bundled one, which is how a
      // deployment runs something other than Pi — and how this path is
      // exercised without spending model credits.
      const harness =
        config.harnessCommand ??
        piCommand({
          provider: provider.id,
          model: config.model,
          thinking: config.thinking,
          skills: skillArguments(),
        });

      // `"$(cat …)"` and not the prompt itself. The prompt carries an issue
      // body written by whoever can file one, and this string is executed by a
      // shell — but a command substitution inside double quotes expands to a
      // single word that the shell never rescans for operators, so nothing in
      // the file can become part of the command. Redirecting it to stdin
      // instead is what the previous version did, and Pi in `--mode json`
      // takes its prompt as an argument.
      const agent = await sandbox.exec(
        `cd /workspace/repo && ${harness} "$(cat /workspace/prompt.md)"`,
        { timeoutMs: config.limits?.maxDurationMs ?? 30 * 60 * 1000 },
      );
      egressDenied += agent.egressDenied;

      // The event stream is the run's history and the agent's own report on
      // what it did. Read before the exit code is judged, because a harness
      // that died halfway still says where it got to, and that is most of what
      // makes a failed run worth reading.
      const parsed = parsePiEvents(agent.stdout);

      for (const step of parsed.steps) {
        await this.agentRuns
          .appendEvent(
            run.id,
            {
              message: scrubSecrets(step.message, secrets),
              level: step.level,
              phase: step.phase,
              ...(step.data ? { data: step.data } : {}),
            },
            { workspaceId: run.workspaceId },
          )
          .catch((): undefined => undefined);
      }

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

      // What the agent said, not what this file says about it. "Finished in a
      // hosted sandbox" was true of every run and told a reviewer nothing;
      // the closing report the prompt asks for is the thing they came to read.
      const summary = scrubSecrets(
        parsed.summary ?? 'Finished the work.',
        secrets,
      );

      await this.agentRuns.transition(run.id, 'SUCCEEDED', {
        summary,
        modelId: parsed.modelId ?? undefined,
        iterationCount: parsed.iterations,
        result: {
          delivery: 'pull_request',
          branch: pushed.branch,
          prUrl: pushed.prUrl,
          headCommit: pushed.headCommit,
          egressDenied,
          ...(parsed.costUsd ? { costUsd: parsed.costUsd } : {}),
        },
      });

      await this.handback.post(run.issueId, run.agentUserId, run.id, {
        status: 'SUCCEEDED',
        summary,
        branch: pushed.branch,
        prUrl: pushed.prUrl,
        attempt: run.attempt,
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
    summary?: string | null,
  ) {
    await this.agentRuns
      .transition(run.id, 'FAILED', {
        failure,
        error: error.slice(0, 4000),
        ...(summary ? { summary } : {}),
        result: { egressDenied },
      })
      .catch((): undefined => undefined);

    // A failed run says so on the issue too. Silence here is what made a
    // sandbox failure invisible to everyone not watching the runs list.
    await this.handback
      .post(run.issueId, run.agentUserId, run.id, {
        status: 'FAILED',
        failure,
        error,
        summary,
        attempt: run.attempt,
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
