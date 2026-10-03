import type { AgentExecutor, ExecutorAvailability } from './executor.interface';
import type { ContextPack } from '../context-pack.service';
import type {
  CycleLimits,
  CyclePass,
  CycleSpend,
  ReviewFinding,
} from '../review-cycle';
import type { VerificationOutcome } from '../review-prompt';
import type { AgentRun } from '@prisma/client';
import type { MeteredModelCall, SandboxHandle } from '@vantikhq/types';

import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  type AgentRunRepoSource,
  PI_LAUNCHER,
  PI_REQUIRED_FLAGS,
  THINKING_LEVELS,
  isSafeModelId,
  providerById,
} from '@vantikhq/types';

import { LoggerService } from 'modules/logger/logger.service';

import { AGENT_RUN_LEASE_MS } from '../agent-runs.interface';
import { AgentRunsService } from '../agent-runs.service';
import { ExecutorRegistry } from './executor.registry';
import { buildAgentPrompt, verificationCommands } from '../agent-prompt';
import {
  IMPLEMENTER_SKILLS,
  REVIEWER_SKILLS,
  skillArguments,
  skillFiles,
} from '../agent-skills';
import { reconcileSpend } from './metered-spend';
import { CredentialsService } from '../credentials/credentials.service';
import { evidencePaths } from '../evidence-paths';
import {
  CONTEXT_PATH,
  extensionFiles,
  extensionGuestPath,
  OUTBOX_PATH,
  POLICY_PATH,
} from '../pi-extension/seed';
import {
  MIN_USEFUL_MS,
  decideCycle,
  keepEvidenced,
  parseReviewVerdict,
  phaseName,
  resolveCycleLimits,
} from '../review-cycle';
import { buildReviewPrompt, buildRevisionPrompt } from '../review-prompt';
import { PROVIDE_PACKAGE_MANAGER } from './package-manager';
import { PiEventReader, type ParsedStep, type RunFailure } from './pi-events';
import { RunTelemetry, startRunTelemetry } from './run-telemetry';
import { type Spend, SpendMeter } from './spend-meter';
import { RunHandbackService } from '../run-handback.service';
import {
  newOutboxState,
  OUTBOX_LIMITS,
  OutboxBatch,
  OutboxResult,
  OutboxState,
  readOutbox,
  RunOutboxService,
} from '../run-outbox';
import { GitProxyService } from '../sandbox/git-proxy.service';
import { PushScopeError } from '../sandbox/push-scope';
import { RemoteSandboxRuntime } from '../sandbox/remote.runtime';
import { scrubSecrets } from '../sandbox/scrub';
import {
  BASE_DIR,
  GENERATED_DIRS,
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
  /** The Vantik extension's absolute guest path. Additive under `--no-extensions`. */
  extension?: string;
}): string {
  const args = [PI_LAUNCHER, ...PI_REQUIRED_FLAGS];

  // Ours, by path, and nothing else: `--no-extensions` still stops Pi loading
  // one from the checkout, and `-e` adds exactly this file, which the host
  // wrote outside it. Checked rather than quoted, like a skill path — it is a
  // constant, so the check never fails, and it is cheap to keep.
  if (options.extension && /^\/workspace\/[\w.-]+$/.test(options.extension)) {
    args.push('-e', options.extension);
  }

  // Explicit, because discovery is off. `--no-skills` stops Pi reading skills
  // out of the checkout — where they would be instructions written by whoever
  // can land a file in the repository — and `--skill` still loads the ones we
  // chose, which is the same shape as `--no-extensions`.
  for (const skill of options.skills ?? []) {
    args.push('--skill', skill);
  }

  // Quoted, so the shell reads an id as it is: OpenRouter's aliases start
  // with `~`, which unquoted would expand to a home directory.
  if (options.provider && isSafeModelId(options.provider)) {
    args.push('--provider', `'${options.provider}'`);
  }

  if (options.model && isSafeModelId(options.model)) {
    args.push('--model', `'${options.model}'`);
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
    // npm, unconditionally: on an image without this Pi baked in, the harness
    // is fetched with `npx`, and a run that cannot reach the registry then has
    // no agent at all.
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
 * Whether git's output says the remote refused the push. GitHub says
 * `[rejected]`; Forgejo and Gitea say `[remote rejected]` when a pre-receive
 * hook refuses an account that has no write access.
 */
export function isPushRejection(message: string): boolean {
  return /\[(remote )?rejected\]|non-fast-forward|protected branch|denying|not allowed to push|pre-receive hook declined/i.test(
    message,
  );
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

/**
 * The largest packed tree read back from the guest, in bytes.
 *
 * It comes back base64 encoded in one string, and V8 will not build a string
 * much past 512 MB, so a tree near that crashes the run at the last step with
 * an error about string lengths. Well short of it, with room for the copies
 * the decode makes, a run is failed saying what is too big instead.
 */
const MAX_TREE_BYTES = 200 * 1024 * 1024;

/** The exit code the pack command uses for a tree over `MAX_TREE_BYTES`. */
const TREE_TOO_LARGE = 3;

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
  /** The run's spend, kept on the run while it works. */
  meter: SpendMeter;
  /** The run's trace, which the harness's events are fed into. */
  telemetry: RunTelemetry;
  /** What the agent has asked to write to Vantik so far. */
  outbox: OutboxState;
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
      /** A provider that refused the call, or a harness that broke. */
      failure: 'MODEL_REFUSED' | 'HARNESS_CRASHED';
      error: string;
      summary: string | null;
      costUsd: number;
      egressDenied: number;
    };

/** One harness invocation's outcome, whichever job it was doing. */
interface Invocation {
  exitCode: number;
  stderr: string;
  /** Why the provider would not answer, when that is why it stopped. */
  refusal: RunFailure | null;
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
 * The value-add is that there is nothing for the user to keep alive.
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

  /** Open traces, so whichever path ends a run can end its trace. */
  private readonly traces = new Map<string, RunTelemetry>();

  /** Live guests, so cancel can actually kill one. */
  private readonly running = new Map<string, SandboxHandle>();
  /** Where each sandbox's metered calls were last read up to. */
  private readonly meteredSince = new WeakMap<SandboxHandle, number>();

  constructor(
    private registry: ExecutorRegistry,
    private runtime: RemoteSandboxRuntime,
    private credentials: CredentialsService,
    private gitProxy: GitProxyService,
    private handback: RunHandbackService,
    private agentRuns: AgentRunsService,
    private outbox: RunOutboxService,
  ) {}

  async onModuleInit() {
    this.registry.register(this);

    // Not awaited: the sandbox host may be down, and that must not hold up
    // the server's boot.
    void this.disposeLeftoverSandboxes();
  }

  /**
   * Disposes of the sandboxes whose runs have ended.
   *
   * A server that stopped mid-run left its sandbox behind. The sandbox host
   * disposes of it anyway once the keepalives stop, but not for some minutes,
   * and the model key sits in its hooks until then. A sandbox of a run that
   * is still working is left alone: on two replicas it belongs to the other.
   */
  private async disposeLeftoverSandboxes(): Promise<void> {
    try {
      const sandboxes = await this.runtime.list();

      if (sandboxes.length === 0) {
        return;
      }

      const idle = await this.agentRuns.idleRunIds(
        sandboxes.map((sandbox) => sandbox.runId),
      );

      for (const sandbox of sandboxes.filter((s) => idle.has(s.runId))) {
        this.logger.info({
          message: `Disposing of sandbox ${sandbox.id}, left by run ${sandbox.runId}`,
          where: 'HostedExecutor.disposeLeftoverSandboxes',
        });
        await this.runtime.dispose(sandbox.id);
      }
    } catch {
      // No sandbox host, or none reachable: there is nothing to clean up that
      // this server could reach anyway.
    }
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
          'This server cannot reach a sandbox host, so agent runs are unavailable here.',
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

    // One trace per run, started before anything can refuse it, so a run that
    // fails on a missing key is as visible to the telemetry backend as one that
    // fails three passes in. `fail` and the success path end it with the
    // outcome; `finally` ends whatever neither of them reached.
    const telemetry = startRunTelemetry({
      runId: run.id,
      issueId: run.issueId,
      agentUserId: run.agentUserId,
      executor: run.executor,
      attempt: run.attempt,
      provider: config.provider ?? null,
      model: config.model ?? null,
    });
    this.traces.set(run.id, telemetry);

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
    telemetry.setModel(model.provider, config.model ?? null);

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
    // What the model calls cost, kept outside the cycle so a run that fails
    // after spending still says what it spent: the knowledge arms compare
    // mean cost, and leaving failures out would flatter whichever arm fails
    // expensively. Written to the run as it grows, so a person can watch a
    // run approach its budget rather than find out when it stops.
    const meter = new SpendMeter((spent) =>
      this.agentRuns.recordSpend(run.id, spent),
    );
    let releaseLease: (() => void) | undefined;

    const note = async (message: string, phase: string) => {
      telemetry.phase(phase);
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
        leaseExpiresAt: new Date(Date.now() + AGENT_RUN_LEASE_MS),
      });

      // From here on the run is answerable for its own liveness. Started after
      // the claim rather than before, so a run that never claims — because
      // something else already did — never renews a lease it does not hold.
      releaseLease = this.holdLease(run);

      // ---- Phase 0: the checkout, host-side, before anything boots. ----
      //
      // Ordered ahead of the guest deliberately. The egress allowlist is fixed
      // at VM creation and cannot be widened afterwards, and what a run is
      // allowed to reach depends on the toolchain its module needs — so the
      // checkout has to exist before the machine does. It also means a run
      // that could never proceed no longer pays for a microVM first: the
      // repository check below used to run after a boot.
      await note('Fetching the repository', 'setup');

      // The repository comes from the issue's modules, as a reference the
      // server resolves through the connected source. There is no URL or path
      // to fall back on, so an issue whose modules name no repository stops
      // here and says so.
      const source = config.source as AgentRunRepoSource | undefined;
      if (!source?.integrationAccountId || !source.externalRepoId) {
        await this.fail(
          run,
          'ENVIRONMENT_SETUP_FAILED',
          'This run has no repository to open. Link the issue’s modules to a ' +
            'repository in Settings → Modules.',
        );
        return;
      }

      let checkout;
      try {
        checkout = await this.gitProxy.materializeCheckout({
          workspaceId: run.workspaceId,
          source,
          baseBranch: config.baseBranch,
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
          'Fetching the repository used this run’s whole time budget, so ' +
            'there was none left to work in. Raise the run’s maxDurationMs.',
          egressDenied,
        );
        return;
      }

      // Its own step, so a sandbox that will not boot is not reported as a
      // repository that would not fetch.
      await note('Starting the sandbox', 'setup');

      sandbox = await this.runtime.create({
        runId: run.id,
        files: {
          // The prompt goes in as a file rather than an argument, so it never
          // appears in a process listing the guest can read — and so nothing
          // from an issue body is ever interpolated into a shell command.
          'prompt.md': buildAgentPrompt(pack),
          // The pack itself. The Vantik tools read the issue and the knowledge
          // from it, and it answers "what was this run given" from inside a
          // guest somebody is debugging.
          [CONTEXT_PATH]: JSON.stringify(pack, null, 2),
          // What the agent knows before it reads the repository: how to read a
          // Vantik issue, how to write a change worth reviewing, and — for the
          // review pass only — how to review one.
          ...skillFiles(),
          // How the reviewer sees a change rather than a directory. Only
          // seeded when there is going to be a reviewer.
          ...(reviewing ? { [TREE_TOOLS_PATH]: TREE_TOOLS_SCRIPT } : {}),
          // The Vantik extension and what it is told about this run. Outside
          // the checkout, so it is never part of the work and never pushed.
          ...extensionFiles(pack, config.egressHosts),
        },
        env: {
          VANTIK_POLICY: `/workspace/${POLICY_PATH}`,
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
        { timeoutMs: limits.deadlineAt - Date.now() },
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

      // Before the setup commands, because they are usually `pnpm install`.
      const packageManager = await sandbox.exec(PROVIDE_PACKAGE_MANAGER, {
        timeoutMs: limits.deadlineAt - Date.now(),
      });
      egressDenied += packageManager.egressDenied;

      if (packageManager.exitCode !== 0) {
        await this.fail(
          run,
          'ENVIRONMENT_SETUP_FAILED',
          scrubSecrets(
            `Could not install the package manager that package.json names\n${packageManager.stderr}`,
            secrets,
          ),
          egressDenied,
        );
        return;
      }

      for (const command of config.setupCommands ?? []) {
        const result = await sandbox.exec(`cd /workspace/repo && ${command}`, {
          timeoutMs: limits.deadlineAt - Date.now(),
        });
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
        traceId: this.traces.get(run.id)?.traceId,
      });

      // ---- Phase 2: the cycle. Reduced egress, no install credentials. ----
      const outbox = newOutboxState();
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
          meter,
          telemetry,
          outbox,
        },
        reviewing,
      );

      egressDenied += cycle.egressDenied;

      if (cycle.kind === 'failed') {
        await this.fail(
          run,
          cycle.failure,
          cycle.error,
          egressDenied,
          cycle.summary,
          meter.total,
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
        { timeoutMs: limits.deadlineAt - Date.now() },
      );
      egressDenied += swept.egressDenied;

      // The tree comes back as an archive rather than a patch: the guest has
      // no git, and asking it to describe its own changes would be asking the
      // thing under test what it did. The host compares it against the base it
      // cloned.
      //
      // Generated directories stay behind: setup installed dependencies into
      // the checkout, and the push would discard them anyway. BusyBox matches
      // an exclude against whole path components, so `.git` does not take
      // `.github` or `.gitignore` with it.
      const packed = await sandbox.exec(
        [
          `tar czf /tmp/tree.tar.gz ${GENERATED_DIRS.map(
            (name) => `--exclude=${name}`,
          ).join(' ')} -C /workspace/repo .`,
          `size=$(wc -c < /tmp/tree.tar.gz)`,
          `if [ "$size" -gt ${MAX_TREE_BYTES} ]; then ` +
            `echo "the packed tree is $size bytes" >&2; ` +
            `rm -f /tmp/tree.tar.gz; exit ${TREE_TOO_LARGE}; fi`,
          'base64 /tmp/tree.tar.gz > /workspace/tree.b64',
          'rm -f /tmp/tree.tar.gz',
        ].join(' && '),
        { timeoutMs: limits.deadlineAt - Date.now() },
      );
      egressDenied += packed.egressDenied;

      if (packed.exitCode !== 0) {
        const why = scrubSecrets(packed.stderr, secrets).trim();

        await this.fail(
          run,
          'HARNESS_CRASHED',
          packed.exitCode === TREE_TOO_LARGE
            ? `The working tree is too large to push: ${why}, over the ${
                MAX_TREE_BYTES / 1024 / 1024
              } MB limit. A generated directory the run left in the checkout is the usual cause.`
            : `The sandbox produced no readable working tree: ${why}`,
          egressDenied,
          cycle.summary,
          meter.total,
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
        source,
        baseBranch: checkout.baseBranch,
        branch: `agent/${String(pack.issue?.key ?? run.issueId).toLowerCase()}`,
        treeBase64,
        baseCommit,
        commitMessage: `${pack.issue?.key ?? ''}: ${pack.issue?.title ?? 'Agent work'}`,
        issueKey: pack.issue?.key ?? run.issueId,
        issueTitle: pack.issue?.title ?? 'Agent work',
        summary: pullRequestBody(cycle),
        coAuthor: await this.agentRuns.delegator(run),
        scope: { pathPrefixes: pack.repo?.pathPrefixes ?? [] },
      });

      if (!pushed) {
        await this.fail(
          run,
          'NO_DIFF_PRODUCED',
          `The agent changed nothing. ${cycle.reason}`,
          egressDenied,
          cycle.summary,
          meter.total,
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
          delivery: pushed.delivery,
          branch: pushed.branch,
          prUrl: pushed.prUrl,
          headCommit: pushed.headCommit,
          egressDenied,
          reviewPasses: cycle.passes,
          ...spentFields(meter.total),
        },
      });

      // Only now: a criterion the agent called met is a claim, and a run its
      // checks and reviewer signed off is what stands behind it.
      if (status === 'SUCCEEDED' && outbox.criteria.size) {
        const ticked = await this.outbox.tickCriteria(run, outbox);
        await note(describeOutbox({ ticked }), 'handback');
      }

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

      telemetry.end({ status });
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
        error instanceof PushScopeError || isPushRejection(message)
          ? 'PUSH_REJECTED'
          : sandbox
            ? 'HARNESS_CRASHED'
            : 'ENVIRONMENT_SETUP_FAILED',
        scrubSecrets(message, secrets),
        egressDenied,
        null,
        meter.total,
      );
    } finally {
      // Always. On success, on failure, on cancel — the VM, the checkout, the
      // decrypted key and the lease all go. The lease first: a renewal firing
      // after the run reached a terminal state finds nothing to renew, but a
      // timer nobody cleared keeps this run's id alive in the event loop.
      releaseLease?.();
      meter.stop();
      await sandbox?.dispose();
      this.running.delete(run.id);
      // A no-op when the outcome already ended it. Otherwise the run left this
      // executor some other way — cancelled, swept, or a transition someone
      // else won — and the trace says only that it stopped here.
      telemetry.end({ status: 'ENDED_ELSEWHERE' });
      this.traces.delete(run.id);
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
            failure: attempt.refusal ? 'MODEL_REFUSED' : 'HARNESS_CRASHED',
            error: attempt.stderr,
            summary,
            costUsd: spend.costUsd,
            egressDenied,
          };
        }

        needsReview = true;
        reason = attempt.refusal
          ? `The model provider refused the call on pass ${pass} ` +
            `(${attempt.refusal.message}), so the work from the earlier ` +
            `passes is delivered as it stood.`
          : `The harness crashed on pass ${pass}, so the work from the earlier ` +
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

      // A reviewer whose provider refused it said nothing, and recording that
      // as "no readable verdict" would blame the reviewer for the provider.
      // Another pass would be refused the same way.
      if (review.refusal && !review.verdict) {
        needsReview = true;
        reason =
          `The model provider refused the reviewer's call on pass ${pass} ` +
          `(${review.refusal.message}), so the work is delivered unreviewed.`;
        break;
      }

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
      await this.recordPass(cx, record, checks.outcomes, {
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
   *
   * After it, whatever the agent queued for Vantik is checked and applied, so
   * its notes reach the issue while the run is still working.
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
    const invocation = await this.runHarness(cx, options);
    await this.drainOutbox(cx, options.phase);
    return invocation;
  }

  /**
   * Reads the outbox lines the agent added since the last pass, and applies
   * what passes the checks in run-outbox.ts. Never throws: Vantik writes are
   * a courtesy to the people tracking the issue, not part of the work.
   */
  private async drainOutbox(cx: CycleContext, phase: string): Promise<void> {
    try {
      // Bounded in the guest, so an outbox the agent filled with junk costs
      // the host nothing to read.
      const read = await cx.sandbox.exec(
        `head -n ${OUTBOX_LIMITS.lines} /workspace/${OUTBOX_PATH} 2>/dev/null | head -c 1048576`,
        { timeoutMs: 15_000 },
      );
      if (!read.stdout) {
        return;
      }

      const batch = readOutbox(read.stdout, cx.pack, cx.outbox);
      const applied = await this.outbox.apply(
        cx.run,
        batch,
        factScope(cx.pack),
        (text) => scrubSecrets(text, cx.secrets),
      );
      const message = describeOutbox({ batch, applied });
      if (message) {
        await cx.note(message, phase);
      }
    } catch {
      // Reported nowhere on purpose: a missing outbox is the normal case.
    }
  }

  /**
   * What one harness command spent, by the provider's bill where there is one.
   *
   * The harness prices each call from its own catalog and keeps no cost a
   * provider sends. The sandbox host meters the same calls from the
   * provider's responses, so each call the meter has a billed cost for is
   * counted at that, and the chat spans waiting on usage are settled with the
   * provider's figures. A sandbox host that meters nothing, or cannot be
   * asked, leaves the harness's figures standing.
   */
  private async billedSpend(
    cx: CycleContext,
    reader: PiEventReader,
  ): Promise<Spend> {
    let calls: MeteredModelCall[] = [];

    if (cx.sandbox.modelCalls) {
      try {
        const since = this.meteredSince.get(cx.sandbox) ?? 0;
        const metered = await cx.sandbox.modelCalls(since);
        this.meteredSince.set(cx.sandbox, metered.next);
        calls = metered.calls;
      } catch (error) {
        this.logger.warn({
          message: `Could not read the metered model calls of run ${cx.run.id}; its spend is the harness's own`,
          where: 'HostedExecutor.billedSpend',
          error: error instanceof Error ? error : undefined,
        });
      }
    }

    cx.telemetry.meter(calls);
    const spend = reconcileSpend(reader.calls, calls);

    return { costUsd: spend.costUsd, turns: reader.spent.turns };
  }

  private async runHarness(
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
        extension: extensionGuestPath(),
      });

    // Each step goes to the timeline as the harness reports it, so a person
    // can watch the agent work rather than wait for it to finish. Recorded in
    // order, one at a time, and never allowed to fail the invocation: the
    // timeline is the record of the work, not a part of it.
    cx.telemetry.phase(options.phase);
    const reader = new PiEventReader((event) => cx.telemetry.observe(event));
    let recorded = Promise.resolve();
    const record = (steps: ParsedStep[]) => {
      for (const step of steps) {
        recorded = recorded.then(() =>
          this.agentRuns
            .appendEvent(
              cx.run.id,
              {
                message: scrubSecrets(step.message, cx.secrets),
                level: step.level,
                // The parser cannot know which pass it is reading, and every
                // step it produces claims `implement`. Overridden here so the
                // reviewer's tool calls appear under the review rather than
                // under the work it is reviewing.
                phase: options.phase,
                ...(step.data ? { data: step.data } : {}),
              },
              { workspaceId: cx.run.workspaceId },
            )
            .then(
              (): undefined => undefined,
              (): undefined => undefined,
            ),
        );
      }
    };

    // The runtime enforces the deadline by aborting, which surfaces as a throw
    // rather than as an exit code. Caught here and turned into a failed
    // invocation so the cycle can decide what it means: on the first pass that
    // is a crashed run, and on any later one it is a reason to stop and deliver
    // what the earlier passes built.
    let result;

    try {
      result = await cx.sandbox.exec(
        `cd /workspace/repo && ${harness} "$(cat /workspace/${options.promptPath})"`,
        {
          timeoutMs: options.timeoutMs,
          onStdout: (chunk) => {
            record(reader.push(chunk));
            cx.meter.progress(reader.spent);
          },
        },
      );
    } catch (error) {
      // The steps it reported before it was stopped are on the timeline
      // already; only a last line without an LF is still to record.
      record(reader.flush());
      await recorded;

      // What it spent before it was stopped is still spent.
      const partial = reader.result();
      const billed = await this.billedSpend(cx, reader);
      await cx.meter.settle(billed);

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
        refusal: null,
        summary: null,
        modelId: partial.modelId,
        costUsd: billed.costUsd,
        turns: partial.iterations,
        egressDenied: 0,
      };
    }

    // A runtime that does not stream gives the output only with the result.
    // Read then, before the exit code is judged, because a harness that died
    // halfway still says where it got to, and that is most of what makes a
    // failed run worth reading.
    if (!reader.received) {
      record(reader.push(result.stdout));
    }
    record(reader.flush());
    await recorded;

    const parsed = reader.result();
    const billed = await this.billedSpend(cx, reader);
    await cx.meter.settle(billed);

    return {
      // A model that never answered is a failed invocation, whatever the
      // harness's own exit code says. Pi exits zero when the provider refuses
      // it — a bad model id, a rejected key, a rate limit — and read literally
      // that is a pass which did the work and had nothing to report. The run
      // then spends its budget on passes that cannot do anything and ends up
      // blaming the reviewer for not producing a verdict.
      exitCode:
        result.exitCode === 0 && parsed.failure
          ? MODEL_FAILED
          : result.exitCode,
      // The provider's own sentence, which says what to fix — "requires more
      // credits", "invalid API key". Its whole body is on the timeline.
      stderr: scrubSecrets(
        parsed.failure ? parsed.failure.message : result.stderr,
        cx.secrets,
      ),
      refusal: parsed.failure
        ? {
            ...parsed.failure,
            message: scrubSecrets(parsed.failure.message, cx.secrets),
            raw: scrubSecrets(parsed.failure.raw, cx.secrets),
          }
        : null,
      summary: parsed.summary,
      modelId: parsed.modelId,
      costUsd: billed.costUsd,
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
    refusal: RunFailure | null;
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
      refusal: attempt.refusal,
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
    checks: VerificationOutcome[],
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
          accepted: pass.accepted,
          // Where each failing check failed, for attributing the failure to
          // the knowledge the run was handed. The output is not kept.
          failedChecks: checks
            .filter((check) => !check.ok)
            .map((check) => ({
              label: check.label,
              command: check.command,
              paths: evidencePaths(check.output),
            })),
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
      | 'MODEL_REFUSED'
      | 'NO_DIFF_PRODUCED'
      | 'PUSH_REJECTED',
    error: string,
    egressDenied = 0,
    summary?: string | null,
    spent: Spend = { costUsd: 0, turns: 0 },
  ) {
    // Gated on the transition landing. A run this executor lost — swept for a
    // lapsed lease, cancelled from the UI — is already terminal and already
    // spoke for itself, and a second comment saying it crashed would contradict
    // the first one on the same issue.
    const failed = await this.agentRuns
      .transition(run.id, 'FAILED', {
        failure,
        error: error.slice(0, 4000),
        // Set here too: a run refused before it started running has a trace
        // as well, and it is the one most worth finding.
        traceId: this.traces.get(run.id)?.traceId,
        ...(summary ? { summary } : {}),
        result: { egressDenied, ...spentFields(spent) },
      })
      .then(() => true)
      .catch(() => false);

    if (!failed) {
      return;
    }

    this.traces.get(run.id)?.end({ status: 'FAILED', failure, error });

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
   * Keeps a run visible to the sweeper for as long as it is really working.
   *
   * A hosted run is an unawaited promise in this process. If the process dies
   * — or the promise is lost — nothing marks the row: the run stays RUNNING
   * for ever, holds a slot against the workspace's concurrency cap, and blocks
   * its own issue from being delegated again. The lease is the answer the
   * server already had, and this is the half that was missing, which is
   * somebody renewing it.
   *
   * This replaced a boot-time reconcile that failed every hosted run in
   * CLAIMED or RUNNING across the whole deployment. That was right on one
   * replica and wrong on two: a rolling deploy had each booting replica kill
   * the other's live work and tell the user to retry a run that was still
   * going. A lease is owned by the run rather than by whoever booted last.
   *
   * Renewed at a third of the lease, so two consecutive failures — a database
   * blip, a paused event loop — still leave a full renewal's grace before the
   * sweeper takes the run. The timer is unref'd: holding a lease is not a
   * reason for the process to stay alive.
   */
  private holdLease(run: AgentRun): () => void {
    const every = Math.max(Math.floor(AGENT_RUN_LEASE_MS / 3), 1000);

    const timer = setInterval(() => {
      void this.agentRuns
        .renewLease(run.id)
        .then(async (held) => {
          if (held) {
            return;
          }

          // The run moved on without us — swept, or cancelled. Killing the
          // guest is the whole point of noticing: the sweeper has already
          // opened a fresh attempt at this issue, and two sandboxes doing the
          // same work is the user's money spent twice for one result.
          this.logger.info({
            message: `Hosted run ${run.id} lost its lease; disposing the sandbox`,
            where: 'HostedExecutor.holdLease',
          });

          clearInterval(timer);
          await this.cancel(run);
        })
        .catch((): undefined => undefined);
    }, every);

    timer.unref?.();

    return () => clearInterval(timer);
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

/**
 * A run's spend as fields of its result. A run that spent nothing — it failed
 * before the model was called — records nothing rather than a zero.
 */
function spentFields(spent: Spend): { costUsd?: number; turns?: number } {
  return {
    ...(spent.costUsd ? { costUsd: spent.costUsd } : {}),
    ...(spent.turns ? { turns: spent.turns } : {}),
  };
}

/** Where an agent's facts are scoped when they name no page. */
function factScope(pack: ContextPack): string {
  return pack.repo?.pathPrefixes?.[0] ?? pack.repo?.location ?? 'repository';
}

/** One timeline line for what came of the agent's writes to Vantik. */
export function describeOutbox(outcome: {
  batch?: OutboxBatch;
  applied?: OutboxResult;
  ticked?: OutboxResult;
}): string {
  const count = (n: number, one: string, many = `${one}s`) =>
    `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  const applied = outcome.applied?.applied ?? [];
  const notes = applied.filter((a) => a === 'note').length;
  const facts = applied.filter((a) => a === 'fact').length;

  if (notes) {
    parts.push(`posted ${count(notes, 'note')} on the issue`);
  }
  if (facts) {
    parts.push(`proposed ${count(facts, 'fact')}`);
  }
  if (outcome.batch?.criteria.length) {
    parts.push(
      `claimed ${count(outcome.batch.criteria.length, 'criterion', 'criteria')} met, to tick if the run succeeds`,
    );
  }
  if (outcome.ticked?.applied.length) {
    parts.push(
      `ticked ${count(outcome.ticked.applied.length, 'criterion', 'criteria')} the agent showed were met`,
    );
  }
  const failed = [
    ...(outcome.applied?.failed ?? []),
    ...(outcome.ticked?.failed ?? []),
  ];
  if (failed.length) {
    parts.push(`could not apply ${failed.length} (${failed.join('; ')})`);
  }
  if (outcome.batch?.rejected.length) {
    const reasons = [...new Set(outcome.batch.rejected.map((r) => r.reason))];
    parts.push(
      `refused ${count(outcome.batch.rejected.length, 'line')} of the outbox (${reasons.join(', ')})`,
    );
  }

  if (!parts.length) {
    return '';
  }
  const text = parts.join('; ');
  return `Vantik: ${text}.`;
}
