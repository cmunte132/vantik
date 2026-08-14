import type { AgentExecutor, ExecutorAvailability } from './executor.interface';
import type { ContextPack } from '../context-pack.service';
import type {
  CycleLimits,
  CyclePass,
  CycleSpend,
  ReviewFinding,
} from '../review-cycle';
import type { VerificationOutcome } from '../review-prompt';
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
import { buildAgentPrompt, verificationCommands } from '../agent-prompt';
import {
  IMPLEMENTER_SKILLS,
  REVIEWER_SKILLS,
  skillArguments,
  skillFiles,
} from '../agent-skills';
import { CredentialsService } from '../credentials/credentials.service';
import {
  MIN_USEFUL_MS,
  decideCycle,
  keepEvidenced,
  parseReviewVerdict,
  phaseName,
  resolveCycleLimits,
} from '../review-cycle';
import { buildReviewPrompt, buildRevisionPrompt } from '../review-prompt';
import { parsePiEvents } from './pi-events';
import { RunHandbackService } from '../run-handback.service';
import { GitProxyService } from '../sandbox/git-proxy.service';
import { GondolinRuntime } from '../sandbox/gondolin.runtime';
import { scrubSecrets } from '../sandbox/scrub';
import {
  BASE_DIR,
  TREE_HASH_COMMAND,
  TREE_TOOLS_PATH,
  TREE_TOOLS_SCRIPT,
} from '../sandbox/tree-tools';

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

/** Harness scratch that must never reach the diff. Never legitimately tracked. */
const HARNESS_ARTIFACTS = ['.pi', '.pi-session', '.vantik-run'];

/** Longest any single verification command may take. */
const MAX_CHECK_MS = 10 * 60 * 1000;

/**
 * Below this there is not enough time left to run a check honestly.
 *
 * A suite given four seconds is killed on the way up, and recording that as
 * "the tests failed" would hand the reviewer a fact that is not one.
 */
const MIN_CHECK_MS = 30 * 1000;

/** Exit code for a command the runtime stopped rather than one that ran. */
const TIMED_OUT = 124;

/**
 * Exit code for a harness that ran fine and never reached a model.
 *
 * Synthesised here because Pi exits zero in that case. 125 is the shell's own
 * "the command could not be invoked", which is what this is: the harness was
 * started, and the thing it exists to call refused.
 */
const MODEL_FAILED = 125;

/** Enough for a content hash of a large tree, and not enough to hide in. */
const TREE_HASH_TIMEOUT_MS = 3 * 60 * 1000;

/** Tail of a failing check's output kept for the reviewer and the event row. */
const CHECK_OUTPUT_BYTES = 4000;

/**
 * Everything one pass of the cycle needs, gathered once.
 *
 * Passed as a bag rather than threaded through six parameters because the
 * alternative is six call sites that each drop a different one.
 */
interface CycleContext {
  run: AgentRun;
  sandbox: SandboxHandle;
  pack: ContextPack;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any;
  providerId: string;
  secrets: string[];
  limits: CycleLimits;
  note: (message: string, phase: string) => Promise<void>;
}

/** What the whole cycle came to. */
type CycleResult =
  | {
      kind: 'done';
      /**
       * True when nothing signed the work off — budget spent, the loop stopped
       * changing, the reviewer gave no readable answer. The diff is still
       * delivered; it just goes to a person rather than being called finished.
       */
      needsReview: boolean;
      reason: string;
      summary: string | null;
      /**
       * What the last review said was still wrong, and its own summing-up.
       *
       * Carried out of the loop rather than left in the iteration rows. On a
       * run nothing signed off, this is the most useful thing anybody gets:
       * "why it stopped" tells a person the budget ran out, and this tells them
       * what to go and look at.
       */
      outstanding: ReviewFinding[];
      reviewSummary?: string;
      modelId: string | null;
      turns: number;
      costUsd: number;
      egressDenied: number;
      passes: number;
      phaseTimings: Record<string, number>;
    }
  | {
      kind: 'failed';
      error: string;
      summary: string | null;
      egressDenied: number;
    };

/** One harness invocation's outcome, whichever job it was doing. */
interface Invocation {
  exitCode: number;
  stderr: string;
  summary: string | null;
  modelId: string | null;
  costUsd: number;
  turns: number;
  egressDenied: number;
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
 *
 * The work itself is a cycle rather than a single shot: implement, run the
 * repository's own checks, hand the tree to a *separate* agent that reviews it
 * against the issue, and send its evidenced findings back to be fixed. That
 * repeats inside one sandbox until the reviewer accepts or the issue's budget
 * is spent. See `review-cycle.ts` for why it stops where it stops.
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
    // Stored as JSON, so the column's type is `JsonValue` and nothing narrows
    // it. Asserted rather than validated: the pack was written by this server
    // at dispatch, and every reader below is already tolerant of a field the
    // pack does not carry.
    const pack = (run.contextPack ?? {}) as unknown as ContextPack;

    // The clock starts here, not when the agent does. A budget that excludes
    // the clone is not a budget for the run — and a repository so large that
    // fetching it eats the wall clock is a fact somebody needs to see rather
    // than one to absorb silently.
    const startedAt = Date.now();
    const limits = resolveCycleLimits(config.limits, startedAt);

    // Reviewing is on unless the workspace turned it off. An agent that grades
    // its own work is the failure this executor exists to avoid, so the
    // expensive option is the default and the cheap one is a choice.
    const reviewing: boolean = config.phases?.review ?? true;

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

    // The run's model, or no run. Pi has a default and would quietly use it,
    // which would put the work on a model nobody picked, bill it to whoever
    // configured the key, and leave "which model wrote this diff" unanswerable
    // from the run row. `piCommand` drops an id it cannot pass safely, so an
    // unusable one lands in the same place as a missing one and is refused
    // here rather than silently becoming the default.
    //
    // Not asked of a deployment that brought its own harness: the model is not
    // passed to it, and its command is where the choice was already made.
    if (!config.harnessCommand && !isSafeModelId(String(config.model ?? ''))) {
      await this.fail(
        run,
        'ENVIRONMENT_SETUP_FAILED',
        config.model
          ? `"${String(config.model).slice(0, 60)}" is not a model id this can pass to the harness, and the run will not fall back to the harness's own default. Choose a model for this workspace's agent runs.`
          : 'This run named no model, and it will not fall back to the harness’s own default. Choose one in the workspace’s agent settings, or when delegating the issue.',
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
          'This run has no repository to open. Point the issue’s modules at ' +
            'one, or set a default in Settings → Agents.',
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
          egressDenied,
        );
        return;
      }

      // A clone that ate the wall clock leaves nothing to run the work in, and
      // the microVM's own deadline would come out negative — which aborts the
      // first command and reads as a crashed agent. Said plainly instead, since
      // the fix is a bigger ceiling or a smaller repository.
      if (limits.deadlineAt - Date.now() < MIN_USEFUL_MS) {
        await this.fail(
          run,
          'ENVIRONMENT_SETUP_FAILED',
          'Fetching the repository used this run’s whole time budget, so there ' +
            'was none left to work in. Raise the run’s maxDurationMs, or use ' +
            'the BYO runner for a repository this size.',
          egressDenied,
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
          // Vantik issue, how to write a change worth reviewing, and — for the
          // review pass only — how to review one.
          ...skillFiles(),
          // How the reviewer sees a change rather than a directory. Only
          // seeded when there is going to be a reviewer.
          ...(reviewing ? { [TREE_TOOLS_PATH]: TREE_TOOLS_SCRIPT } : {}),
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
          // The whole cycle's wall clock, not one pass's. The runtime enforces
          // it as a backstop; the cycle stops itself well before, so that a
          // run out of time still delivers the tree it has.
          maxDurationMs: limits.deadlineAt - Date.now(),
          memoryMb: 4096,
          // Larger when reviewing, because a pristine copy of the base tree
          // lives beside the working one for the whole run.
          diskMb: reviewing ? 30720 : 20480,
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
      const setupStart = Date.now();
      await note('Preparing the sandbox', 'setup');

      await sandbox.writeFile('repo.tar.gz.b64', checkout.archiveBase64);

      // Unpacked twice when there is going to be a review: `/workspace/base`
      // is the tree as it was before anybody touched it, and it is what makes
      // a diff possible in a guest that has no git. Extracted here, before the
      // setup commands run, so it holds the repository rather than the
      // repository plus whatever `npm install` left behind.
      const unpack = await sandbox.exec(
        [
          `mkdir -p /workspace/repo${reviewing ? ` ${BASE_DIR}` : ''}`,
          'base64 -d /workspace/repo.tar.gz.b64 > /workspace/repo.tar.gz',
          'tar xzf /workspace/repo.tar.gz -C /workspace/repo',
          ...(reviewing
            ? [`tar xzf /workspace/repo.tar.gz -C ${BASE_DIR}`]
            : []),
          'rm -f /workspace/repo.tar.gz /workspace/repo.tar.gz.b64',
        ].join(' && '),
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
      const setupMs = Date.now() - setupStart;

      await this.agentRuns.transition(run.id, 'RUNNING', {
        startedAt: new Date(),
        baseCommit,
      });

      // ---- Phase 2: the cycle. Reduced egress, no install credentials. ----
      const cycle = await this.runCycle(
        {
          run,
          sandbox,
          pack,
          config,
          providerId: provider.id,
          secrets,
          limits,
          note,
        },
        reviewing,
      );

      egressDenied += cycle.egressDenied;

      if (cycle.kind === 'failed') {
        await this.fail(
          run,
          'HARNESS_CRASHED',
          cycle.error,
          egressDenied,
          cycle.summary,
        );
        return;
      }

      // ---- Handback: host-side, with a credential the guest never held. ----
      await note('Pushing the branch', 'report');
      const reportStart = Date.now();

      // Harness scratch and the cycle's own files are removed before the tree
      // is read. A reviewer who finds `.pi/` in a pull request stops trusting
      // the rest of it, and a `review-2.json` we asked for is our litter, not
      // the agent's work.
      const swept = await sandbox.exec(
        [
          `cd /workspace/repo`,
          `rm -rf ${HARNESS_ARTIFACTS.join(' ')}`,
          // Only ever the exact names this run used, and only when the base
          // tree did not already carry one. A glob here would delete a
          // `review-2024.json` that belongs to the repository.
          ...cycleArtifacts(cycle.passes).map(
            (file) => `{ [ -e ${BASE_DIR}/${file} ] || rm -f ${file}; }`,
          ),
        ].join(' && '),
      );
      egressDenied += swept.egressDenied;

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
          cycle.summary,
        );
        return;
      }

      // BusyBox `base64` wraps its output; the decoder does not care, but the
      // newlines would otherwise travel all the way into a Buffer conversion.
      const treeBase64 = (await sandbox.readFile('tree.b64')).replace(
        /\s+/g,
        '',
      );

      const pushed = await this.gitProxy.pushWorkTree({
        workspaceId: run.workspaceId,
        repoUrl: cloneUrl,
        branch: `agent/${String(pack.issue?.key ?? run.issueId).toLowerCase()}`,
        treeBase64,
        baseCommit,
        commitMessage: `${pack.issue?.key ?? ''}: ${pack.issue?.title ?? 'Agent work'}`,
        issueKey: pack.issue?.key ?? run.issueId,
        issueTitle: pack.issue?.title ?? 'Agent work',
        summary: pullRequestBody(cycle),
      });

      if (!pushed) {
        await this.fail(
          run,
          'NO_DIFF_PRODUCED',
          `The agent changed nothing. ${cycle.reason}`,
          egressDenied,
          cycle.summary,
        );
        return;
      }

      // What the agent said, not what this file says about it. "Finished in a
      // hosted sandbox" was true of every run and told a reviewer nothing;
      // the closing report the prompt asks for is the thing they came to read.
      const summary = scrubSecrets(
        cycle.summary ?? 'Finished the work.',
        secrets,
      );

      // A run nothing signed off is not a failure and must not read as one —
      // the work exists and is on a branch. It is also not a success, because
      // no reviewer said so. NEEDS_REVIEW is the state for exactly that, and
      // saying which of the two happened is the point of the whole cycle.
      const status = cycle.needsReview ? 'NEEDS_REVIEW' : 'SUCCEEDED';

      await this.agentRuns.transition(run.id, status, {
        summary,
        modelId: cycle.modelId ?? undefined,
        iterationCount: cycle.turns,
        phaseTimings: {
          setup: setupMs,
          ...cycle.phaseTimings,
          report: Date.now() - reportStart,
        },
        result: {
          delivery: 'pull_request',
          branch: pushed.branch,
          prUrl: pushed.prUrl,
          headCommit: pushed.headCommit,
          egressDenied,
          reviewPasses: cycle.passes,
          ...(cycle.costUsd ? { costUsd: cycle.costUsd } : {}),
        },
      });

      await this.handback.post(run.issueId, run.agentUserId, run.id, {
        status,
        // On a run that stopped without being signed off, why it stopped and
        // what the reviewer still objected to come first — that is what a
        // person opening the issue has to act on, and the agent's own account
        // of what it did is context underneath it. On an accepted run there is
        // nothing to add, so its report stands alone as it always did.
        summary: cycle.needsReview
          ? [cycle.reason, ...outstandingWork(cycle), '', summary].join('\n')
          : summary,
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

  // ------------------------------------------------------------------- cycle

  /**
   * Implement, verify, review, revise — until something says stop.
   *
   * One sandbox for all of it. The review pass is a fresh harness process with
   * a different prompt and different skills, but the *same* working tree: a
   * reviewer that had to be handed a copy could not run the repository's
   * commands against what it is reviewing, and a reviewer that cannot run
   * anything is back to having an opinion about a diff.
   *
   * Nothing in here throws for an outcome. A crash on the first pass is a
   * failed run because there is nothing to show for it; a crash on any later
   * pass stops the cycle and delivers what the earlier passes built, because
   * throwing away three passes of real work to report the fourth one's exit
   * code helps nobody.
   */
  private async runCycle(
    cx: CycleContext,
    reviewing: boolean,
  ): Promise<CycleResult> {
    const history: CyclePass[] = [];
    const spend: CycleSpend = { costUsd: 0, turns: 0 };
    const phaseTimings: Record<string, number> = {};

    let egressDenied = 0;
    let summary: string | null = null;
    let modelId: string | null = null;
    let needsReview = false;
    let reason = 'Finished the work.';

    let findings: ReviewFinding[] = [];
    let reviewSummary: string | undefined;
    let verification: VerificationOutcome[] = [];

    for (let pass = 1; ; pass += 1) {
      const remaining = cx.limits.deadlineAt - Date.now();

      if (remaining < MIN_USEFUL_MS) {
        needsReview = true;
        reason =
          'The run reached its wall-clock limit for this issue before this ' +
          'pass could start.';
        break;
      }

      // ---- implement, or revise what the reviewer found ----
      const working = phaseName(pass === 1 ? 'implement' : 'revise', pass);
      const workStart = Date.now();

      if (pass > 1) {
        await cx.sandbox.writeFile(
          revisionPromptPath(pass),
          buildRevisionPrompt({
            pack: cx.pack,
            pass,
            findings,
            verification,
            reviewSummary,
          }),
        );
      }

      await cx.note(
        pass === 1
          ? 'Running the agent'
          : `Fixing ${findings.length} finding(s) from the review`,
        working,
      );

      const attempt = await this.invoke(cx, {
        promptPath: pass === 1 ? 'prompt.md' : revisionPromptPath(pass),
        skills: skillArguments(IMPLEMENTER_SKILLS),
        phase: working,
        timeoutMs: remaining,
      });

      egressDenied += attempt.egressDenied;
      spend.costUsd += attempt.costUsd;
      spend.turns += attempt.turns;
      summary = attempt.summary ?? summary;
      modelId = attempt.modelId ?? modelId;
      phaseTimings[working] = Date.now() - workStart;

      if (attempt.exitCode !== 0) {
        if (pass === 1) {
          return {
            kind: 'failed',
            error: attempt.stderr,
            summary,
            egressDenied,
          };
        }

        needsReview = true;
        reason =
          `The harness crashed on pass ${pass}, so the work from the earlier ` +
          `passes is delivered as it stood.`;
        break;
      }

      if (!reviewing) {
        // The single-shot path, unchanged: no checks run, no reviewer, and the
        // run reads exactly as it did before this cycle existed.
        break;
      }

      // Taken here, before anything else touches the guest, so it measures what
      // the implementer produced and nothing else. Taken after the review it
      // would also cover a test cache the checks wrote and a verdict file a
      // reviewer left in the checkout despite being told not to — and since
      // each pass leaves a differently-named one, the hash would differ every
      // pass and the oscillation check would never fire.
      const diffHash = await this.treeHash(cx);

      // ---- verify: the execution-grounded signal every opinion rests on ----
      const verifyPhase = phaseName('verify', pass);
      const verifyStart = Date.now();
      const checks = await this.verify(cx, verifyPhase);

      egressDenied += checks.egressDenied;
      verification = checks.outcomes;
      phaseTimings[verifyPhase] = Date.now() - verifyStart;

      // A review started with a minute left is killed partway through reading
      // the diff, and its silence would then be recorded as "the reviewer gave
      // no readable verdict" — which is true but points at the reviewer rather
      // than at the clock that stopped it. Said properly instead, and the model
      // call is not paid for.
      if (cx.limits.deadlineAt - Date.now() < MIN_USEFUL_MS) {
        needsReview = true;
        reason =
          `The run reached its wall-clock limit for this issue after pass ` +
          `${pass} did the work, so nothing reviewed it.`;
        break;
      }

      // ---- review: a different agent, on the same tree ----
      const reviewPhase = phaseName('review', pass);
      const reviewStart = Date.now();
      const review = await this.review(cx, pass, verification, reviewPhase);

      egressDenied += review.egressDenied;
      spend.costUsd += review.costUsd;
      spend.turns += review.turns;
      modelId = review.modelId ?? modelId;
      phaseTimings[reviewPhase] = Date.now() - reviewStart;

      findings = keepEvidenced(review.verdict?.findings ?? []);
      reviewSummary = review.verdict?.summary;

      const record: CyclePass = {
        index: pass,
        verificationPassed: checks.passed,
        accepted: review.verdict
          ? // A blocking finding and an acceptance contradict each other, and
            // the finding is the half backed by a file and a line.
            review.verdict.accepted &&
            !findings.some((finding) => finding.severity === 'high')
          : null,
        findings,
        diffHash,
      };

      history.push(record);
      await this.recordPass(cx, record, {
        [verifyPhase]: phaseTimings[verifyPhase],
        [reviewPhase]: phaseTimings[reviewPhase],
        [working]: phaseTimings[working],
      });

      await cx.note(
        record.accepted === true
          ? 'The reviewer accepted the work'
          : record.accepted === null
            ? 'The reviewer gave no readable verdict'
            : `The reviewer found ${findings.length} thing(s) to fix`,
        reviewPhase,
      );

      const decision = decideCycle({
        history,
        spend,
        limits: cx.limits,
        now: Date.now(),
      });

      reason = decision.reason;

      if (decision.action === 'accept') {
        break;
      }

      if (decision.action === 'handOver') {
        needsReview = true;
        break;
      }
    }

    return {
      kind: 'done',
      needsReview,
      reason,
      summary,
      // Only what the *last* review left open. Findings from an earlier pass
      // were either fixed or filed again, and listing both would tell a reader
      // the work is twice as broken as it is.
      outstanding: needsReview ? findings : [],
      ...(needsReview && reviewSummary ? { reviewSummary } : {}),
      modelId,
      turns: spend.turns,
      costUsd: spend.costUsd,
      egressDenied,
      passes: history.length,
      phaseTimings,
    };
  }

  /**
   * One harness invocation, whichever job it is doing.
   *
   * `"$(cat …)"` and not the prompt itself. The prompt carries an issue body
   * written by whoever can file one, and this string is executed by a shell —
   * but a command substitution inside double quotes expands to a single word
   * that the shell never rescans for operators, so nothing in the file can
   * become part of the command.
   */
  private async invoke(
    cx: CycleContext,
    options: {
      promptPath: string;
      skills: string[];
      phase: string;
      timeoutMs: number;
    },
  ): Promise<Invocation> {
    // A configured harness command replaces the bundled one, which is how a
    // deployment runs something other than Pi — and how this path is exercised
    // without spending model credits.
    const harness =
      cx.config.harnessCommand ??
      piCommand({
        provider: cx.providerId,
        model: cx.config.model,
        thinking: cx.config.thinking,
        skills: options.skills,
      });

    // The runtime enforces the deadline by aborting, which surfaces as a throw
    // rather than as an exit code. Caught here and turned into a failed
    // invocation so the cycle can decide what it means: on the first pass that
    // is a crashed run, and on any later one it is a reason to stop and deliver
    // what the earlier passes built.
    let result;

    try {
      result = await cx.sandbox.exec(
        `cd /workspace/repo && ${harness} "$(cat /workspace/${options.promptPath})"`,
        { timeoutMs: options.timeoutMs },
      );
    } catch (error) {
      return {
        exitCode: TIMED_OUT,
        stderr: scrubSecrets(
          `The harness was stopped after ${Math.round(
            options.timeoutMs / 1000,
          )}s without finishing: ${
            error instanceof Error ? error.message : String(error)
          }`,
          cx.secrets,
        ),
        summary: null,
        modelId: null,
        costUsd: 0,
        turns: 0,
        egressDenied: 0,
      };
    }

    // The event stream is the run's history and the agent's own report on what
    // it did. Read before the exit code is judged, because a harness that died
    // halfway still says where it got to, and that is most of what makes a
    // failed run worth reading.
    const parsed = parsePiEvents(result.stdout);

    for (const step of parsed.steps) {
      await this.agentRuns
        .appendEvent(
          cx.run.id,
          {
            message: scrubSecrets(step.message, cx.secrets),
            level: step.level,
            // The parser cannot know which pass it is reading, and every step
            // it produces claims `implement`. Overridden here so the reviewer's
            // tool calls appear under the review rather than under the work it
            // is reviewing.
            phase: options.phase,
            ...(step.data ? { data: step.data } : {}),
          },
          { workspaceId: cx.run.workspaceId },
        )
        .catch((): undefined => undefined);
    }

    return {
      // A model that never answered is a failed invocation, whatever the
      // harness's own exit code says. Pi exits zero when the provider refuses
      // it — a bad model id, a rejected key, a rate limit — and read literally
      // that is a pass which did the work and had nothing to report. The run
      // then spends its budget on passes that cannot do anything and ends up
      // blaming the reviewer for not producing a verdict.
      exitCode:
        result.exitCode === 0 && parsed.failure ? MODEL_FAILED : result.exitCode,
      stderr: scrubSecrets(
        parsed.failure
          ? `The model did not answer: ${parsed.failure.message}`
          : result.stderr,
        cx.secrets,
      ),
      summary: parsed.summary,
      modelId: parsed.modelId,
      costUsd: parsed.costUsd,
      turns: parsed.iterations,
      egressDenied: result.egressDenied,
    };
  }

  /**
   * The repository's own checks, run by the host against the guest's tree.
   *
   * Run here rather than trusted from the agent's report. An agent that
   * believes it ran the tests and did not is a common and quiet failure, and
   * the reviewer's whole grounding is that this result is a fact rather than a
   * claim.
   *
   * A check that fails does not fail the run. It is evidence, handed to the
   * reviewer and then to the next pass — failing here would throw away a diff
   * that is one fix away from being right.
   */
  private async verify(
    cx: CycleContext,
    phase: string,
  ): Promise<{
    outcomes: VerificationOutcome[];
    passed: boolean | null;
    egressDenied: number;
  }> {
    const commands = verificationCommands(cx.pack);

    if (commands.length === 0) {
      return { outcomes: [], passed: null, egressDenied: 0 };
    }

    await cx.note('Running the repository’s own checks', phase);

    const outcomes: VerificationOutcome[] = [];
    let egressDenied = 0;

    for (const [label, command] of commands) {
      const remaining = cx.limits.deadlineAt - Date.now();

      if (remaining < MIN_CHECK_MS) {
        // Out of time. Left out of the report rather than recorded as failed:
        // telling a reviewer the tests failed when nobody ran them is worse
        // than telling it nothing, and it says so when the list is empty.
        break;
      }

      const allowed = Math.min(remaining, MAX_CHECK_MS);
      let result;

      try {
        result = await cx.sandbox.exec(`cd /workspace/repo && ${command}`, {
          timeoutMs: allowed,
        });
      } catch {
        // A check the runtime had to stop is a real failure — a suite that
        // hangs is a suite that does not pass — and the reviewer is told which
        // kind of failure it was rather than being shown an empty log.
        result = {
          exitCode: TIMED_OUT,
          stdout: '',
          stderr: `This check did not finish within ${Math.round(allowed / 1000)}s.`,
          egressDenied: 0,
        };
      }

      egressDenied += result.egressDenied;

      const ok = result.exitCode === 0;

      outcomes.push({
        label,
        command,
        ok,
        ...(ok
          ? {}
          : {
              output: scrubSecrets(
                `${result.stdout}\n${result.stderr}`.trim(),
                cx.secrets,
              ).slice(-CHECK_OUTPUT_BYTES),
            }),
      });

      await this.agentRuns
        .appendEvent(
          cx.run.id,
          {
            message: `${label}: ${ok ? 'passed' : 'failed'}`,
            level: ok ? 'INFO' : 'ERROR',
            phase,
            data: { kind: 'test', command, ok, exit: result.exitCode },
          },
          { workspaceId: cx.run.workspaceId },
        )
        .catch((): undefined => undefined);
    }

    return {
      outcomes,
      passed:
        outcomes.length === 0 ? null : outcomes.every((check) => check.ok),
      egressDenied,
    };
  }

  /**
   * The review pass.
   *
   * The verdict is read from a file the reviewer writes rather than parsed out
   * of its prose, so "did it accept" is a boolean somebody wrote deliberately
   * instead of a sentiment read off a paragraph. Its closing message is tried
   * as a fallback, because a model told to write JSON to a path quite often
   * writes the JSON and forgets the path.
   *
   * A reviewer that produces nothing readable yields a null verdict, and null
   * never means yes — `decideCycle` hands those runs to a person.
   */
  private async review(
    cx: CycleContext,
    pass: number,
    verification: VerificationOutcome[],
    phase: string,
  ): Promise<{
    verdict: ReturnType<typeof parseReviewVerdict>;
    costUsd: number;
    turns: number;
    modelId: string | null;
    egressDenied: number;
  }> {
    const promptPath = `review-${pass}.md`;

    await cx.sandbox.writeFile(
      promptPath,
      buildReviewPrompt(cx.pack, { pass, verification }),
    );

    await cx.note('Reviewing the work against the issue', phase);

    const attempt = await this.invoke(cx, {
      promptPath,
      skills: skillArguments(REVIEWER_SKILLS),
      phase,
      timeoutMs: Math.max(cx.limits.deadlineAt - Date.now(), 0),
    });

    let raw: string | null = null;

    try {
      raw = await cx.sandbox.readFile(verdictFile(pass));
    } catch {
      // No file. Not an error worth reporting on its own — the fallback below
      // catches the common case, and a genuinely silent reviewer is handled by
      // the null verdict.
      raw = null;
    }

    return {
      verdict: parseReviewVerdict(raw) ?? parseReviewVerdict(attempt.summary),
      costUsd: attempt.costUsd,
      turns: attempt.turns,
      modelId: attempt.modelId,
      egressDenied: attempt.egressDenied,
    };
  }

  /**
   * A stable content hash of the working tree.
   *
   * Only ever used to notice a pass that changed nothing, so a guest that
   * cannot produce one costs the run its oscillation check rather than the
   * run. Null is handled as "unknown" everywhere it is read.
   */
  private async treeHash(cx: CycleContext): Promise<string | null> {
    try {
      const result = await cx.sandbox.exec(TREE_HASH_COMMAND, {
        timeoutMs: TREE_HASH_TIMEOUT_MS,
      });

      const hash = result.stdout.trim().split('\n').pop()?.trim() ?? '';

      return result.exitCode === 0 && /^[0-9a-f]{16,}$/.test(hash)
        ? hash.slice(0, 32)
        : null;
    } catch {
      return null;
    }
  }

  /**
   * One pass, on the record.
   *
   * The pass-rate fields stay empty on purpose. They belong to the specify and
   * score phases, which derive a held-out suite the implementer never sees;
   * this cycle runs neither, so reporting a number for them would be inventing
   * the measurement the column exists to hold. Δ is left null by the service
   * for the same reason.
   */
  private async recordPass(
    cx: CycleContext,
    pass: CyclePass,
    phaseTimings: Record<string, number>,
  ): Promise<void> {
    await this.agentRuns
      .recordIteration(
        cx.run.id,
        {
          index: pass.index,
          ...(pass.verificationPassed === null
            ? {}
            : { verificationPassed: pass.verificationPassed }),
          findings: pass.findings,
          ...(pass.diffHash ? { diffHash: pass.diffHash } : {}),
          phaseTimings,
        },
        { workspaceId: cx.run.workspaceId },
      )
      .catch((): undefined => undefined);
  }

  // ----------------------------------------------------------------- failure

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

function revisionPromptPath(pass: number): string {
  return `revise-${pass}.md`;
}

function verdictFile(pass: number): string {
  return `review-${pass}.json`;
}

/**
 * Files the cycle asked the guest to write, which the repository never asked
 * for.
 *
 * Named exactly rather than matched with a glob: the reviewer is told to write
 * outside the checkout, but a model that ignores that leaves its verdict in the
 * repository, and a `rm review-*.json` there would take a file that belongs to
 * the project with it.
 */
function cycleArtifacts(passes: number): string[] {
  const files: string[] = [];

  for (let pass = 1; pass <= passes; pass += 1) {
    files.push(verdictFile(pass), `review-${pass}.md`);

    if (pass > 1) {
      files.push(revisionPromptPath(pass));
    }
  }

  return files;
}

/**
 * What the last review left open, as something a person can act on.
 *
 * Empty when the work was accepted, or when the reviewer never produced a
 * readable answer — in the second case the reason already says so, and a
 * "still open" heading with nothing under it would suggest the reviewer found
 * nothing wrong rather than that it said nothing at all.
 */
function outstandingWork(cycle: {
  outstanding: ReviewFinding[];
  reviewSummary?: string;
}): string[] {
  const lines: string[] = [];

  if (cycle.reviewSummary) {
    lines.push('', `> ${cycle.reviewSummary.replace(/\n/g, '\n> ')}`);
  }

  if (cycle.outstanding.length) {
    lines.push(
      '',
      'Still open when the run stopped:',
      '',
      ...cycle.outstanding.map(
        (finding) =>
          `- ${finding.message}${finding.evidence ? ` — \`${finding.evidence}\`` : ''}`,
      ),
    );
  }

  return lines;
}

/**
 * What the pull request says about how this diff got here.
 *
 * Somebody opening it should know whether anything checked the work before they
 * did, because "an agent wrote this" and "an agent wrote this and a second
 * agent signed it off" call for different amounts of attention. The findings
 * are repeated here as well as on the issue on purpose: whoever opens the pull
 * request from the git host never sees the issue comment, and what the reviewer
 * could not get fixed is the most useful thing they could be told.
 */
function pullRequestBody(cycle: {
  needsReview: boolean;
  reason: string;
  passes: number;
  outstanding: ReviewFinding[];
  reviewSummary?: string;
}): string {
  if (cycle.passes === 0) {
    return 'Opened by a Vantik agent running in a hosted sandbox.';
  }

  if (!cycle.needsReview) {
    return (
      `Opened by a Vantik agent running in a hosted sandbox. A second agent ` +
      `reviewed it against the issue over ${cycle.passes} pass(es) and ` +
      `accepted it. Review the diff, not the transcript.`
    );
  }

  return [
    `Opened by a Vantik agent running in a hosted sandbox, after ` +
      `${cycle.passes} review pass(es). **Nothing signed this off:** ` +
      `${cycle.reason} Read it closely.`,
    ...outstandingWork(cycle),
  ].join('\n');
}

// A `shellSafe` guard used to sit here, for the repo url and base branch that
// were interpolated into the guest's `git clone`. Both now go to host-side git
// as argv rather than through a shell, so there is no interpolation left to
// guard — the escaping problem was removed rather than solved.
