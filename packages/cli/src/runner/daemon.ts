import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { Harness } from './contract';
import { deliver, type Delivery } from './delivery';
import { RunnerError, type AgentRunFailure } from './failures';
import { diffStat, hasChanges, scrubArtifacts } from './git';
import { isTestSpecifiable, resolvePhases } from './loop/phases';
import { PiHarness } from './pi-harness';
import { prepareWorkspace } from './workspace';
import type { ClaimedRun, ReportInput, RunnerClient } from './client';

export interface DaemonOptions {
  client: RunnerClient;
  /** Only take work for this backend. */
  executor?: string;
  repoPath?: string;
  baseBranch?: string;
  worktreeRoot?: string;
  /** Seconds between polls when the queue is empty. */
  pollSeconds: number;
  /** How long a single run may take before it is stopped. */
  timeoutMs: number;
  /** Leave the diff on disk; never push, never open a pull request. */
  dryRun?: boolean;
  /** Overrides the bundled harness for every run this daemon takes. */
  harnessCommand?: string;
  /** Model the bundled harness asks for. Recorded on every run. */
  model?: string;
  /** Provider the bundled harness routes through, when the model is ambiguous. */
  provider?: string;
  /** An already-constructed harness, for tests. */
  harness?: Harness;
  /** Take one run and exit, rather than looping. */
  once?: boolean;
  logDir: string;
  log: (line: string) => void;
}

/** Harness scratch that must never reach the diff. */
const HARNESS_ARTIFACTS = ['.pi', '.pi-session', '.vantik-run'];

const HEARTBEAT_MS = 60_000;

/**
 * The runner loop: claim, prepare, run, deliver, report.
 *
 * Every stage maps its failure to a typed category, because those categories
 * are what the user is actually going to be debugging. A generic "run failed"
 * sends someone to a log file; "the push was rejected" sends them to branch
 * protection, which is where the problem is.
 */
export async function runDaemon(options: DaemonOptions): Promise<void> {
  await mkdir(options.logDir, { recursive: true });

  options.log(
    `Watching for work${options.executor ? ` (${options.executor})` : ''}. Polling every ${options.pollSeconds}s.`,
  );

  for (;;) {
    let run: ClaimedRun | null = null;

    try {
      run = await options.client.claim(options.executor);
    } catch (error) {
      // A server that is down or restarting is a normal thing for a
      // long-running daemon to meet. Say so and keep waiting.
      options.log(`Could not reach Vantik: ${message(error)}`);
    }

    if (!run) {
      if (options.once) {
        options.log('Nothing queued.');
        return;
      }
      await sleep(options.pollSeconds * 1000);
      continue;
    }

    await handleRun(run, options);

    if (options.once) {
      return;
    }
  }
}

async function handleRun(run: ClaimedRun, options: DaemonOptions) {
  const logPath = join(options.logDir, `${run.id}.log`);

  // Printed before anything else happens, so a user who wandered off can find
  // what became of the run without knowing anything about how this works.
  options.log('');
  options.log(`Run ${run.id} (attempt ${run.attempt})`);
  options.log(`  ${run.contextPack?.issue?.key ?? run.issueId}: ${run.contextPack?.issue?.title ?? ''}`);
  options.log(`  tail -f ${logPath}`);

  const controller = new AbortController();
  const started = Date.now();
  const phaseTimings: Record<string, number> = {};

  const note = async (
    text: string,
    extra: { phase?: string; level?: string } = {},
  ) => {
    await appendFile(logPath, `${new Date().toISOString()} ${text}\n`).catch(
      () => undefined,
    );
    await options.client
      .event(run.id, { message: text, ...extra })
      .catch(() => undefined);
  };

  // Two independent stop conditions. The timer is the runner's own budget; the
  // heartbeat is the server's, and a lost lease means the work is no longer
  // this runner's to finish — carrying on would produce a branch for a run
  // that has already been re-queued to someone else.
  const budget = setTimeout(() => controller.abort(), options.timeoutMs);
  let leaseLost = false;

  const heartbeat = setInterval(() => {
    options.client.heartbeat(run.id).catch(() => {
      leaseLost = true;
      controller.abort();
    });
  }, HEARTBEAT_MS);

  let cleanup: (() => Promise<void>) | undefined;

  try {
    const config = run.config ?? {};
    const pack = run.contextPack ?? {};
    const issueKey = pack.issue?.key ?? run.issueId;
    const issueTitle = pack.issue?.title ?? 'Agent work';

    const setupStart = Date.now();
    const workspace = await prepareWorkspace({
      repoPath: config.repoPath ?? options.repoPath,
      repoUrl: config.repoUrl,
      baseBranch: config.baseBranch ?? options.baseBranch,
      branchPrefix: config.branchPrefix,
      issueKey,
      issueTitle,
      setupCommands: config.setupCommands,
      onEvent: (text) => void note(text, { phase: 'setup' }),
    });
    cleanup = workspace.cleanup;
    phaseTimings.setup = Date.now() - setupStart;

    // Per-run config wins over the daemon's flag: a run delegated with an
    // explicit harness asked for that one deliberately.
    const harness =
      options.harness ??
      new PiHarness({
        command: config.harnessCommand ?? options.harnessCommand,
        model: config.model ?? options.model,
        provider: config.provider ?? options.provider,
      });

    await options.client.start(run.id, {
      baseCommit: workspace.baseCommit,
      harnessVersion: await harness.version(),
    });

    await note(`Working in ${workspace.workdir} on ${workspace.branch}`, {
      phase: 'setup',
    });

    const implementStart = Date.now();
    const result = await harness.run({
      workdir: workspace.workdir,
      baseCommit: workspace.baseCommit,
      contextPack: pack,
      verification: {
        test: config.testCommand,
        lint: config.lintCommand,
        typecheck: config.typecheckCommand,
        build: config.buildCommand,
      },
      limits: config.limits ?? {},
      onEvent: (event) =>
        void note(event.message, { phase: event.phase, level: event.level }),
      signal: controller.signal,
    });
    phaseTimings.implement = Date.now() - implementStart;

    if (leaseLost) {
      throw new RunnerError(
        'LEASE_LOST',
        'The server expired this run while it was in flight, so the work was abandoned.',
      );
    }

    if (result.outcome === 'failed') {
      // The counters travel with the failure. A run that stopped at a ceiling
      // has to be able to say which one and what it had spent getting there.
      throw new RunnerError(
        result.failure ?? 'HARNESS_CRASHED',
        result.error ?? 'The harness reported a failure.',
        undefined,
        {
          harnessVersion: result.harnessVersion,
          modelId: result.modelId,
          iterationCount: result.iterationCount,
          costUsd: result.costUsd,
          summary: result.summary,
        },
      );
    }

    // Harness scratch is removed from the index before the diff is taken. A
    // reviewer who sees `.pi/` in a pull request stops trusting the rest of it.
    await scrubArtifacts(workspace.workdir, HARNESS_ARTIFACTS);

    // The daemon decides whether anything changed, from the diff — not from
    // the harness saying so. A harness that believes it edited files and did
    // not is a common and quiet failure.
    if (!(await hasChanges(workspace.workdir, workspace.baseCommit))) {
      throw new RunnerError(
        'NO_DIFF_PRODUCED',
        'The harness finished without changing anything.',
      );
    }

    // The ENG-62 loop, when a workspace has switched any of it on. Every
    // phase ships off: the null hypothesis is that implement plus
    // deterministic verification is as good, and nothing has beaten that
    // compute-matched baseline yet.
    const phases = resolvePhases(config.phases);

    if (phases.specify && !isTestSpecifiable(pack)) {
      // A legitimate terminal state, not a failure. Refactors, docs and
      // dependency bumps cannot be pinned down with new tests — a refactor's
      // Definition of Done is "behaviour unchanged" — and reporting that as a
      // failure trains people to ignore the category.
      await note(
        'This issue cannot be specified with tests; routing to human review.',
        { phase: 'specify' },
      );

      await options.client.report(run.id, {
        needsReview: true,
        summary:
          'The work is done, but no executable test could be derived from the ' +
          'Definition of Done — this is a change whose correctness a person has ' +
          'to judge.',
        phaseTimings,
      });
      return;
    }

    const stat = await diffStat(workspace.workdir, workspace.baseCommit);
    await note(
      `${stat.filesChanged} file(s) changed, +${stat.insertions} −${stat.deletions}`,
      { phase: 'report' },
    );

    const reportStart = Date.now();
    const delivered = await deliver({
      workdir: workspace.workdir,
      repoPath: config.repoPath ?? options.repoPath,
      branch: workspace.branch,
      issueKey,
      issueTitle,
      summary: result.summary ?? 'Agent work.',
      issueUrl: pack.issue?.url,
      delivery: (config.delivery as Delivery) ?? 'worktree',
      worktreeRoot: config.worktreeRoot ?? options.worktreeRoot,
      baseBranch: config.baseBranch ?? options.baseBranch,
      dryRun: options.dryRun,
      onEvent: (text) => void note(text, { phase: 'report' }),
    });
    phaseTimings.report = Date.now() - reportStart;

    await options.client.report(run.id, {
      summary: result.summary,
      delivery: delivered.delivery,
      branch: delivered.branch,
      prUrl: delivered.prUrl,
      worktreePath: delivered.worktreePath,
      headCommit: delivered.headCommit,
      baseCommit: workspace.baseCommit,
      harnessVersion: result.harnessVersion,
      modelId: result.modelId,
      iterationCount: result.iterationCount,
      phaseTimings,
      counters: {
        filesChanged: stat.filesChanged,
        insertions: stat.insertions,
        deletions: stat.deletions,
        ...(result.promptTokens ? { promptTokens: result.promptTokens } : {}),
        ...(result.completionTokens
          ? { completionTokens: result.completionTokens }
          : {}),
      },
    });

    options.log(
      `  done in ${Math.round((Date.now() - started) / 1000)}s — ${
        delivered.prUrl ?? delivered.worktreePath ?? delivered.branch
      }`,
    );
  } catch (error) {
    await reportFailure(run, error, options, phaseTimings, logPath);
  } finally {
    clearTimeout(budget);
    clearInterval(heartbeat);
    // The scratch checkout goes, always. Worktree delivery has already copied
    // the branch into the user's own repository, so nothing is lost.
    await cleanup?.();
  }
}

async function reportFailure(
  run: ClaimedRun,
  error: unknown,
  options: DaemonOptions,
  phaseTimings: Record<string, number>,
  logPath: string,
) {
  const failure: AgentRunFailure =
    error instanceof RunnerError ? error.failure : 'HARNESS_CRASHED';
  const text = message(error);

  options.log(`  failed: ${failure} — ${text}`);
  options.log(`  see ${logPath}`);

  await appendFile(logPath, `\nFAILED ${failure}: ${text}\n`).catch(
    () => undefined,
  );

  const counters = error instanceof RunnerError ? error.counters : undefined;

  const report: ReportInput = {
    failure,
    error: text.slice(0, 4000),
    phaseTimings,
    ...(counters?.harnessVersion
      ? { harnessVersion: counters.harnessVersion }
      : {}),
    ...(counters?.modelId ? { modelId: counters.modelId } : {}),
    ...(counters?.iterationCount
      ? { iterationCount: counters.iterationCount }
      : {}),
    ...(counters?.costUsd ? { counters: { costUsd: counters.costUsd } } : {}),
    ...(counters?.summary ? { summary: counters.summary } : {}),
  };

  // A lost lease means the server already moved this run on, so reporting
  // would be refused by the transition table. Nothing to say.
  if (failure === 'LEASE_LOST') {
    return;
  }

  await options.client.report(run.id, report).catch((reportError) => {
    options.log(`  could not report the failure: ${message(reportError)}`);
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
