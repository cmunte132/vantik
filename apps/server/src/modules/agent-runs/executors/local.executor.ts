import type {
  AgentExecutor,
  ExecutorAvailability,
  ExecutorRequester,
} from './executor.interface';
import type { ContextPack } from '../context-pack.service';
import type { AgentQuestion, AgentRun } from '@prisma/client';
import type {
  ConnectorAck,
  ConnectorHello,
  ConnectorRunDispatch,
  ConnectorRunEntries,
  ConnectorRunEvents,
  ConnectorRunFinished,
  ConnectorRunOutbox,
  ConnectorRunQuestion,
  ConnectorRunStarted,
} from '@vantikhq/types';

import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  AGENT_QUESTION_EXTERNAL_ID_PATTERN,
  type AgentRunFailure,
  isSafeModelId,
  LOCAL_EXECUTOR_KEY,
  THINKING_LEVELS,
} from '@vantikhq/types';
import { LOCAL_REPO_SLUG } from 'integrations/local-repo/repositories';
import { PrismaService } from 'nestjs-prisma';

import { AgentQuestionsService } from 'modules/agent-questions/agent-questions.service';
import { agentSettings } from 'modules/auth/agent-scope';
import { ConnectorRegistry } from 'modules/connector/connector.registry';
import type {
  ConnectorPeer,
  ConnectorRunEvent,
  ConnectorRunHandler,
} from 'modules/connector/connector.registry';
import { GitSourcesService } from 'modules/git/git-sources.service';
import { LoggerService } from 'modules/logger/logger.service';

import { buildAgentPrompt } from '../agent-prompt';
import { AGENT_RUN_LEASE_MS } from '../agent-runs.interface';
import { AgentRunsService } from '../agent-runs.service';
import { guardrailPolicy } from '../pi-extension/seed';
import { resolveCycleLimits } from '../review-cycle';
import { RunHandbackService } from '../run-handback.service';
import {
  newOutboxState,
  OutboxState,
  questionWaitMs,
  readOutbox,
  RunOutboxService,
} from '../run-outbox';
import { RunTokensService } from '../run-tokens.service';
import { answerMessage, refusalMessage } from './question-answer';
import { ExecutorRegistry } from './executor.registry';
import { describeOutbox, factScope, spentFields } from './hosted.executor';
import { PiEventReader, type ParsedStep } from './pi-events';
import { RunTelemetry, startRunTelemetry } from './run-telemetry';
import { SpendMeter } from './spend-meter';
import { scrubSecrets } from '../sandbox/scrub';

export { LOCAL_EXECUTOR_KEY };

/** The wall clock a local run gets when nobody sets one. */
export const LOCAL_DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;

/**
 * How long a run waits for a connector that dropped to come back.
 *
 * A laptop that changes network or wakes from sleep reconnects within
 * seconds; past two minutes the machine is more likely gone than slow.
 */
export const CONNECTOR_GRACE_MS = 2 * 60 * 1000;

/** How long the connector has to acknowledge `run.dispatch`. */
const DISPATCH_ACK_MS = 30 * 1000;

/** How long the connector has to acknowledge `run.answer`. */
const ANSWER_ACK_MS = 10 * 1000;

/** Most events, entries or lines one message may carry. */
const MAX_BATCH = 5000;

/** The longest outbox line and the most outbox text kept per run. */
const MAX_OUTBOX_LINE = 64 * 1024;
const MAX_OUTBOX_TEXT = 1024 * 1024;

/** Everything the server keeps about one run in flight on a connector. */
interface LocalRun {
  run: AgentRun;
  peer: ConnectorPeer;
  pack: ContextPack;
  secrets: string[];
  reader: PiEventReader;
  meter: SpendMeter;
  telemetry: RunTelemetry;
  outbox: OutboxState;
  outboxText: string;
  /** The last message processed; a lower or equal seq is a replay. */
  lastSeq: number;
  /** Messages for one run are handled one at a time, in arrival order. */
  chain: Promise<unknown>;
  /** The run is RUNNING: `run.started` arrived, or `run.finished` forced it. */
  running: boolean;
  closed: boolean;
  worktreePath: string | null;
  branch: string | null;
  ompSessionId: string | null;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  graceTimer?: ReturnType<typeof setTimeout>;
  leaseTimer?: ReturnType<typeof setInterval>;
}

/**
 * Runs an agent on the delegating person's own machine, through the connector
 * they started with `vantik connect`.
 *
 * The server decides, and the connector does: the person delegates from the
 * issue, the server builds the same prompt, context and policy as for a hosted
 * run and sends `run.dispatch`, and omp runs with the person's own model
 * logins. What comes back is the same stream a hosted run reads (Pi events,
 * custom entries, the outbox), fed through the same readers, so a local run
 * looks like any other on the issue.
 *
 * What differs is the credential and the delivery. The run holds a token for
 * the person's personal agent that lives as long as the run, and the work
 * stays on a local branch in a worktree: there is no push and no pull request,
 * because the repository is a directory on the person's machine.
 *
 * State is in memory, like the connector registry: a server restart loses
 * track of runs in flight, and the lease sweep then expires them.
 */
@Injectable()
export class LocalExecutor
  implements AgentExecutor, ConnectorRunHandler, OnModuleInit
{
  readonly key = LOCAL_EXECUTOR_KEY;
  readonly label = 'My machine (omp)';

  private readonly logger = new LoggerService('LocalExecutor');
  private readonly runs = new Map<string, LocalRun>();

  constructor(
    private registry: ExecutorRegistry,
    private connectors: ConnectorRegistry,
    private agentRuns: AgentRunsService,
    private gitSources: GitSourcesService,
    private handback: RunHandbackService,
    private outbox: RunOutboxService,
    private tokens: RunTokensService,
    private prisma: PrismaService,
    private questions: AgentQuestionsService,
  ) {}

  onModuleInit() {
    this.registry.register(this);
    this.connectors.setHandler(this);
  }

  // ------------------------------------------------------------ availability

  /**
   * Usable when this person's connector is online and found omp. Per person:
   * a colleague's connector is not a place this person's work can run.
   */
  async availability(
    requester: ExecutorRequester,
  ): Promise<ExecutorAvailability> {
    if (!requester.userId) {
      return {
        available: false,
        reason: 'Local runs belong to a person. Delegate as yourself.',
      };
    }

    const connector = this.connectors.get({
      workspaceId: requester.workspaceId,
      userId: requester.userId,
    });

    if (!connector) {
      return {
        available: false,
        reason:
          'Run `vantik connect` on your machine to run agents on it. No ' +
          'connector of yours is online.',
      };
    }

    if (!connector.hello.ompVersion) {
      return {
        available: false,
        reason:
          `omp is not installed on ${connector.hello.hostname || 'your machine'}. ` +
          'Install omp, then run `vantik connect` again.',
      };
    }

    return {
      available: true,
      models: connector.hello.models ?? [],
      defaultModel: connector.hello.defaultModel ?? null,
    };
  }

  /**
   * A message when the run asks for a model the person's omp does not have.
   * Only a connector that reported a model list can be checked; one that
   * reported none leaves omp to decide.
   */
  private missingModel(
    peer: ConnectorPeer,
    config: { provider?: string; model?: string },
  ): string | null {
    const { provider, model } = modelOf(config);
    const known = this.connectors.get(peer)?.hello.models;

    if ((!provider && !model) || !known || known.length === 0) {
      return null;
    }

    const found = model
      ? known.some((entry) =>
          provider
            ? entry.provider === provider && entry.id === model
            : entry.id === model || `${entry.provider}/${entry.id}` === model,
        )
      : known.some((entry) => entry.provider === provider);

    return found
      ? null
      : `Your omp setup has no model ${
          model ? (provider ? `${provider}/${model}` : model) : provider
        }. Sign in to that provider in omp, or pick another model.`;
  }

  /** The person's personal agent, which the run token is minted for. */
  async runIdentity(requester: ExecutorRequester): Promise<string | null> {
    if (!requester.userId) {
      return null;
    }

    return this.tokens.personalAgentFor(
      requester.workspaceId,
      requester.userId,
    );
  }

  // ---------------------------------------------------------------- dispatch

  async dispatch(run: AgentRun): Promise<void> {
    const peer = await this.personOf(run);

    if (!peer) {
      await this.fail(
        run,
        'ENVIRONMENT_SETUP_FAILED',
        'This run has no person whose machine could run it.',
      );
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = (run.config ?? {}) as any;
    const pack = (run.contextPack ?? {}) as unknown as ContextPack;

    const missing = this.missingModel(peer, config);

    if (missing) {
      await this.fail(run, 'ENVIRONMENT_SETUP_FAILED', missing);
      return;
    }

    const repo = await this.resolveRepo(run, config);

    if (typeof repo === 'string') {
      await this.fail(run, 'ENVIRONMENT_SETUP_FAILED', repo);
      return;
    }

    const limits = resolveCycleLimits(
      {
        ...config.limits,
        maxDurationMs:
          config.limits?.maxDurationMs ?? LOCAL_DEFAULT_DURATION_MS,
      },
      Date.now(),
    );

    const telemetry = startRunTelemetry({
      runId: run.id,
      issueId: run.issueId,
      agentUserId: run.agentUserId,
      executor: run.executor,
      attempt: run.attempt,
      provider: config.provider ?? null,
      model: config.model ?? null,
    });

    let local: LocalRun | undefined;

    try {
      await this.agentRuns.transition(run.id, 'CLAIMED', {
        claimedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + AGENT_RUN_LEASE_MS),
      });

      const token = await this.tokens.mint({
        runId: run.id,
        workspaceId: run.workspaceId,
        agentUserId: run.agentUserId,
        deadlineAt: new Date(limits.deadlineAt),
      });

      const meter = new SpendMeter((spent) =>
        this.agentRuns.recordSpend(run.id, spent),
      );

      local = {
        run,
        peer,
        pack,
        // Scrubbed from everything written to the run, in case the agent
        // echoes its environment.
        secrets: [token.value],
        reader: new PiEventReader((event) => telemetry.observe(event)),
        meter,
        telemetry,
        outbox: newOutboxState(),
        outboxText: '',
        lastSeq: -1,
        chain: Promise.resolve(),
        running: false,
        closed: false,
        worktreePath: null,
        branch: null,
        ompSessionId: null,
      };

      // Registered before the message goes out: the connector may answer with
      // `run.started` before its acknowledgement of the dispatch arrives.
      this.runs.set(run.id, local);
      this.arm(local, limits.deadlineAt);

      const dispatch: ConnectorRunDispatch = {
        runId: run.id,
        issue: {
          id: pack.issue?.id ?? run.issueId,
          key: pack.issue?.key ?? run.issueId,
          title: pack.issue?.title ?? 'Agent work',
        },
        repo,
        branch: `agent/${String(pack.issue?.key ?? run.issueId).toLowerCase()}`,
        prompt: buildAgentPrompt(pack),
        context: pack,
        policy: policyFor(pack, config.egressHosts, config),
        model: modelOf(config),
        token: {
          value: token.value,
          apiUrl:
            process.env.NEXT_PUBLIC_BACKEND_HOST ??
            process.env.BACKEND_HOST ??
            '',
          expiresAt: token.expiresAt.toISOString(),
        },
        deadlineAt: new Date(limits.deadlineAt).toISOString(),
      };

      const ack = await this.connectors.send(
        peer,
        'run.dispatch',
        dispatch,
        DISPATCH_ACK_MS,
      );

      if (ack.ok === false) {
        await this.fail(
          run,
          'ENVIRONMENT_SETUP_FAILED',
          `Your connector did not take the run: ${ack.reason}`,
          local,
        );
      }
    } catch (error) {
      await this.fail(
        run,
        'ENVIRONMENT_SETUP_FAILED',
        error instanceof Error ? error.message : String(error),
        local,
      );

      if (!local) {
        telemetry.end({ status: 'FAILED' });
      }
    }
  }

  /**
   * Hands the end of a question to the connector. The connector writes the
   * answer file for the tool, or replies to the omp dialog. Returns false
   * when the connector is away or does not acknowledge; the question is then
   * sent again when it comes back.
   */
  async deliverAnswer(
    run: AgentRun,
    question: AgentQuestion,
  ): Promise<boolean> {
    const peer = this.runs.get(run.id)?.peer ?? (await this.personOf(run));

    if (!peer) {
      return false;
    }

    const ack = await this.connectors.send(
      peer,
      'run.answer',
      answerMessage(question),
      ANSWER_ACK_MS,
    );

    return ack.ok;
  }

  /** Sends again every answer of a run that the connector has not taken. */
  private async redeliver(local: LocalRun): Promise<void> {
    try {
      for (const question of await this.questions.undelivered(local.run.id)) {
        if (await this.deliverAnswer(local.run, question)) {
          await this.questions.markDelivered(question.id);
        }
      }
    } catch (error) {
      this.logger.error({
        message: `Run ${local.run.id}: could not resend answers: ${error}`,
        where: 'LocalExecutor.redeliver',
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  /** Tells the connector to stop, and lets go of the run. */
  async cancel(run: AgentRun): Promise<void> {
    const local = this.runs.get(run.id);
    const peer = local?.peer ?? (await this.personOf(run));

    if (peer) {
      await this.connectors.send(peer, 'run.cancel', { runId: run.id }, 5000);
    }

    if (local) {
      this.close(local, 'CANCELED');
    }
  }

  // ------------------------------------------------- connector => the server

  connected(peer: ConnectorPeer, hello?: ConnectorHello): void {
    for (const local of this.runsOf(peer)) {
      // A connector that lists its runs and leaves this one out has lost it
      // (a restart, or a replaced process), so waiting would only hold the
      // issue until the deadline. An older connector lists nothing, and the
      // server trusts its own state.
      if (hello?.activeRunIds && !hello.activeRunIds.includes(local.run.id)) {
        void this.fail(
          local.run,
          'HARNESS_CRASHED',
          'Your connector came back without this run, so it is no longer ' +
            'working on it.',
          local,
        );
        continue;
      }

      if (local.graceTimer) {
        clearTimeout(local.graceTimer);
        local.graceTimer = undefined;
        void this.note(local, 'Your connector is back', 'run');
      }

      // An answer that came while the connector was away goes now.
      void this.redeliver(local);
    }
  }

  disconnected(peer: ConnectorPeer): void {
    for (const local of this.runsOf(peer)) {
      if (local.graceTimer) {
        continue;
      }

      void this.note(
        local,
        `Your connector disconnected. The run fails in ${Math.round(
          CONNECTOR_GRACE_MS / 60_000,
        )} minutes unless it comes back.`,
        'run',
      );

      local.graceTimer = setTimeout(() => {
        void this.fail(
          local.run,
          'HARNESS_CRASHED',
          'Your connector disconnected and did not come back within ' +
            `${Math.round(CONNECTOR_GRACE_MS / 60_000)} minutes.`,
          local,
        );
      }, CONNECTOR_GRACE_MS);
      local.graceTimer.unref?.();
    }
  }

  async handle(
    peer: ConnectorPeer,
    event: ConnectorRunEvent,
    payload: unknown,
  ): Promise<ConnectorAck> {
    const message = payload as { runId?: unknown; seq?: unknown } | null;

    if (
      !message ||
      typeof message.runId !== 'string' ||
      typeof message.seq !== 'number' ||
      !Number.isInteger(message.seq) ||
      message.seq < 0
    ) {
      return {
        ok: false,
        reason: 'The message needs a runId and an integer seq.',
      };
    }

    const local = this.runs.get(message.runId);

    if (!local) {
      return this.unknownRun(peer, message.runId);
    }

    // A person's connector speaks for that person's runs and no one else's.
    if (
      local.peer.userId !== peer.userId ||
      local.peer.workspaceId !== peer.workspaceId
    ) {
      return { ok: false, reason: 'That run is not yours.' };
    }

    const seq = message.seq;

    // One at a time and in order, so a replay cannot overtake the original and
    // two batches of events cannot interleave their steps.
    const result = local.chain.then(async (): Promise<ConnectorAck> => {
      if (local.closed || seq <= local.lastSeq) {
        // Already handled (a retry whose acknowledgement was lost), or the run
        // is over. Acknowledged so the connector stops sending it.
        return { ok: true };
      }

      try {
        await this.process(local, event, payload);
      } catch (error) {
        this.logger.error({
          message: `Run ${local.run.id}: ${event} failed: ${error}`,
          where: 'LocalExecutor.handle',
          error: error instanceof Error ? error : undefined,
        });

        // Not recorded as handled, so the connector's retry is processed.
        return {
          ok: false,
          reason: 'The server could not record the message.',
        };
      }

      local.lastSeq = seq;

      return { ok: true };
    });

    local.chain = result;

    return result;
  }

  /** A message for a run this server is not tracking. */
  private async unknownRun(
    peer: ConnectorPeer,
    runId: string,
  ): Promise<ConnectorAck> {
    const run = await this.prisma.agentRun.findFirst({
      where: { id: runId, workspaceId: peer.workspaceId, deleted: null },
      select: { status: true, executor: true },
    });

    if (!run || run.executor !== LOCAL_EXECUTOR_KEY) {
      return { ok: false, reason: 'No such run.' };
    }

    // Over already: cancelled, failed or expired. There is nothing left to
    // record, and the connector should stop sending.
    if (!['QUEUED', 'CLAIMED', 'RUNNING'].includes(run.status)) {
      return { ok: true };
    }

    return {
      ok: false,
      reason:
        'untracked: the server no longer tracks this run, for example after ' +
        'a restart. Stop it.',
    };
  }

  private async process(
    local: LocalRun,
    event: ConnectorRunEvent,
    payload: unknown,
  ): Promise<void> {
    switch (event) {
      case 'run.started':
        return this.onStarted(local, payload as ConnectorRunStarted);
      case 'run.events':
        return this.onEvents(local, (payload as ConnectorRunEvents).events);
      case 'run.entries':
        return this.onEntries(local, (payload as ConnectorRunEntries).entries);
      case 'run.outbox':
        return this.onOutbox(local, (payload as ConnectorRunOutbox).lines);
      case 'run.question':
        return this.onQuestion(local, payload as ConnectorRunQuestion);
      case 'run.finished':
        return this.onFinished(local, payload as ConnectorRunFinished);
    }
  }

  // ---------------------------------------------------------------- handlers

  private async onStarted(
    local: LocalRun,
    message: ConnectorRunStarted,
  ): Promise<void> {
    local.worktreePath = this.clean(local, message.worktreePath);
    local.branch = this.clean(local, message.branch);
    local.ompSessionId = this.clean(local, message.ompSessionId);

    await this.markRunning(
      local,
      this.clean(local, message.baseCommit) ?? undefined,
    );

    if (local.ompSessionId) {
      await this.agentRuns.recordExternalSession(
        local.run.id,
        local.ompSessionId,
      );
    }

    await this.agentRuns
      .appendEvent(
        local.run.id,
        {
          message: `omp started in ${local.worktreePath ?? 'a worktree'} on ${
            local.branch ?? 'a branch'
          }`,
          // The set-up stage of the run view: the worktree and the session.
          phase: 'setup',
          data: {
            kind: 'session',
            ompSessionId: local.ompSessionId,
            sessionFile: this.clean(local, message.sessionFile),
            worktreePath: local.worktreePath,
            branch: local.branch,
          },
        },
        { workspaceId: local.run.workspaceId },
      )
      .catch((): undefined => undefined);
  }

  private async onEvents(local: LocalRun, events: unknown): Promise<void> {
    if (!Array.isArray(events) || events.length > MAX_BATCH) {
      throw new Error('events must be an array of at most 5000');
    }

    await this.feed(
      local,
      events.map((event) => JSON.stringify(event)),
    );
  }

  /**
   * omp does not emit `entry_appended`, so the connector sends the session
   * entries it polled, and each is read as the event a hosted run would see.
   */
  private async onEntries(local: LocalRun, entries: unknown): Promise<void> {
    if (!Array.isArray(entries) || entries.length > MAX_BATCH) {
      throw new Error('entries must be an array of at most 5000');
    }

    await this.feed(
      local,
      entries.map((entry) => JSON.stringify({ type: 'entry_appended', entry })),
    );
  }

  private async feed(local: LocalRun, lines: Array<string | undefined>) {
    const steps: ParsedStep[] = [];

    for (const line of lines) {
      if (line) {
        steps.push(...local.reader.push(`${line}\n`));
      }
    }

    local.meter.progress(local.reader.spent);

    // Recorded in order and never allowed to fail the message: the timeline is
    // the record of the work, not a part of it.
    for (const step of steps) {
      await this.agentRuns
        .appendEvent(
          local.run.id,
          {
            message: scrubSecrets(step.message, local.secrets),
            level: step.level,
            phase: 'implement',
            ...(step.data ? { data: scrubDeep(step.data, local.secrets) } : {}),
          },
          { workspaceId: local.run.workspaceId },
        )
        .then(
          (): undefined => undefined,
          (): undefined => undefined,
        );
    }
  }

  /** The agent's writes to Vantik, checked and applied as for a hosted run. */
  private async onOutbox(local: LocalRun, lines: unknown): Promise<void> {
    if (!Array.isArray(lines) || lines.length > MAX_BATCH) {
      throw new Error('lines must be an array of at most 5000');
    }

    for (const line of lines) {
      // A line that is too long, or past the text budget, is dropped: the
      // outbox is the agent's to fill and the server's to bound.
      if (
        typeof line !== 'string' ||
        line.length > MAX_OUTBOX_LINE ||
        local.outboxText.length + line.length + 1 > MAX_OUTBOX_TEXT
      ) {
        continue;
      }

      local.outboxText += `${line.replace(/\n/g, ' ')}\n`;
    }

    const batch = readOutbox(local.outboxText, local.pack, local.outbox);
    const applied = await this.outbox.apply(
      local.run,
      batch,
      factScope(local.pack),
      (value) => scrubSecrets(value, local.secrets),
    );
    const message = describeOutbox({ batch, applied });

    if (message) {
      await this.note(local, message, 'implement');
    }

    // The tool waits for an answer file, so a refusal has to reach it.
    for (const refused of applied.refusedQuestions ?? []) {
      void this.connectors.send(
        local.peer,
        'run.answer',
        refusalMessage(local.run.id, refused.id, refused.reason),
        ANSWER_ACK_MS,
      );
    }
  }

  /**
   * A dialog that omp opened for the person, as a question. It becomes the
   * same record as a question from the tool, with the source `omp_dialog`. A
   * dialog that cannot be stored is answered as cancelled, so omp does not
   * wait for ever.
   */
  private async onQuestion(
    local: LocalRun,
    message: ConnectorRunQuestion,
  ): Promise<void> {
    const requester = local.run.createdById;
    let refusal: string | null = null;

    if (!requester) {
      refusal = 'The run has no person to ask.';
    } else if (!AGENT_QUESTION_EXTERNAL_ID_PATTERN.test(String(message.id))) {
      refusal = 'The dialog id is not a plain token.';
    } else {
      try {
        await this.questions.create({
          workspaceId: local.run.workspaceId,
          issueId: local.run.issueId,
          agentRunId: local.run.id,
          externalId: message.id,
          source: 'omp_dialog',
          questions: scrubDeep(message.questions, local.secrets),
          assigneeId: requester,
          waitMs: questionWaitMs(local.run.config),
        });
      } catch (error) {
        if (!(error instanceof RangeError)) {
          throw error;
        }
        refusal = error.message;
      }
    }

    if (refusal) {
      await this.note(local, `Could not ask a person: ${refusal}`, 'implement');
      void this.connectors.send(
        local.peer,
        'run.answer',
        {
          runId: local.run.id,
          questionId: String(message.id).slice(0, 64),
          source: 'omp_dialog',
          status: 'cancelled',
          answers: [],
          text: '',
        },
        ANSWER_ACK_MS,
      );
    }
  }

  private async onFinished(
    local: LocalRun,
    message: ConnectorRunFinished,
  ): Promise<void> {
    local.meter.stop();
    const parsed = local.reader.result();
    const spent = { costUsd: parsed.costUsd, turns: parsed.iterations };
    const summary = scrubSecrets(
      message.summary ?? parsed.summary ?? 'Finished the work.',
      local.secrets,
    );

    if (message.outcome === 'cancelled') {
      await this.agentRuns
        .transition(local.run.id, 'CANCELED', {
          result: this.resultOf(local, spent),
        })
        .catch((): undefined => undefined);
      this.close(local, 'CANCELED');
      return;
    }

    // Pi exits zero when the provider refuses it, and omp's session ends the
    // same way, so the model's failure outranks the connector's cheerful
    // outcome. A run that never reached a model did no work.
    if (message.outcome === 'failed' || parsed.failure) {
      await this.fail(
        local.run,
        parsed.failure ? 'MODEL_REFUSED' : 'HARNESS_CRASHED',
        scrubSecrets(
          parsed.failure?.message ??
            message.error ??
            'omp stopped without finishing the work.',
          local.secrets,
        ),
        local,
        summary,
      );
      return;
    }

    if (!message.branch && !message.headCommit) {
      await this.fail(
        local.run,
        'NO_DIFF_PRODUCED',
        'The agent changed nothing.',
        local,
        summary,
      );
      return;
    }

    // SUCCEEDED is only legal from RUNNING; a run that finished before its
    // `run.started` was recorded is brought there first.
    await this.markRunning(local);

    // The hand-back stage of the run view: what the run leaves behind, and
    // where. A local run pushes nothing, so this is the whole delivery.
    const branch = this.clean(local, message.branch) ?? local.branch;
    const head = this.clean(local, message.headCommit);
    await this.note(
      local,
      `Left ${branch ?? 'the branch'}${head ? ` at ${head.slice(0, 8)}` : ''} in ${
        local.worktreePath ?? 'its worktree'
      }`,
      'report',
    );

    await this.agentRuns.transition(local.run.id, 'SUCCEEDED', {
      summary,
      modelId: parsed.modelId ?? undefined,
      iterationCount: parsed.iterations,
      result: {
        ...this.resultOf(local, spent),
        delivery: 'local-branch',
        branch: this.clean(local, message.branch) ?? local.branch,
        headCommit: this.clean(local, message.headCommit),
      },
    });

    // Only now: a criterion the agent called met is a claim, and a run that
    // finished is what stands behind it.
    if (local.outbox.criteria.size) {
      const ticked = await this.outbox.tickCriteria(local.run, local.outbox);
      await this.note(local, describeOutbox({ ticked }), 'report');
    }

    await this.handback.post(
      local.run.issueId,
      local.run.agentUserId,
      local.run.id,
      {
        status: 'SUCCEEDED',
        summary,
        // The branch is local, so the handback names the branch and the
        // worktree. There is no pull request.
        branch: this.clean(local, message.branch) ?? local.branch,
        worktreePath: local.worktreePath,
        attempt: local.run.attempt,
      },
    );

    this.close(local, 'SUCCEEDED');
  }

  // ----------------------------------------------------------------- helpers

  /** A short string from the connector, with the run's secrets taken out. */
  private clean(local: LocalRun, value: unknown): string | null {
    const kept = text(value);

    return kept ? scrubSecrets(kept, local.secrets) : null;
  }

  private resultOf(local: LocalRun, spent: { costUsd: number; turns: number }) {
    return {
      worktreePath: local.worktreePath,
      branch: local.branch,
      ompSessionId: local.ompSessionId,
      ...spentFields(spent),
    };
  }

  private async markRunning(local: LocalRun, baseCommit?: string) {
    if (local.running) {
      return;
    }

    await this.agentRuns.transition(local.run.id, 'RUNNING', {
      startedAt: new Date(),
      ...(baseCommit ? { baseCommit } : {}),
      traceId: local.telemetry.traceId,
      result: this.resultOf(local, { costUsd: 0, turns: 0 }),
    });

    local.running = true;
  }

  private async note(local: LocalRun, message: string, phase: string) {
    local.telemetry.phase(phase);

    await this.agentRuns
      .appendEvent(
        local.run.id,
        { message: scrubSecrets(message, local.secrets), phase },
        { workspaceId: local.run.workspaceId },
      )
      .catch((): undefined => undefined);
  }

  /**
   * Fails the run, once. Gated on the transition landing: a run the sweep or
   * a cancel already ended spoke for itself, and a second comment saying it
   * crashed would contradict the first.
   */
  private async fail(
    run: AgentRun,
    failure: AgentRunFailure,
    error: string,
    local?: LocalRun,
    summary?: string | null,
  ): Promise<void> {
    if (local?.closed) {
      return;
    }

    // Text from the connector may echo the run token.
    if (local) {
      error = scrubSecrets(error, local.secrets);
      summary = summary ? scrubSecrets(summary, local.secrets) : summary;
    }

    // Stop the connector first for a failure the server decided, so it does
    // not keep spending after the run is over. Best effort.
    if (
      local &&
      (failure === 'HARNESS_CRASHED' || failure === 'BUDGET_EXHAUSTED')
    ) {
      void this.connectors.send(
        local.peer,
        'run.cancel',
        { runId: run.id },
        5000,
      );
    }

    const spent = local?.meter.total ?? { costUsd: 0, turns: 0 };
    const failed = await this.agentRuns
      .transition(run.id, 'FAILED', {
        failure,
        error: error.slice(0, 4000),
        traceId: local?.telemetry.traceId,
        ...(summary ? { summary } : {}),
        result: local ? this.resultOf(local, spent) : { ...spentFields(spent) },
      })
      .then(() => true)
      .catch(() => false);

    if (local) {
      this.close(local, 'FAILED', failure, error);
    }

    if (!failed) {
      return;
    }

    await this.handback
      .post(run.issueId, run.agentUserId, run.id, {
        status: 'FAILED',
        failure,
        error,
        summary,
        worktreePath: local?.worktreePath,
        branch: local?.branch,
        attempt: run.attempt,
      })
      .catch((): undefined => undefined);
  }

  /** Lets go of everything the server holds for a run. */
  private close(
    local: LocalRun,
    status: string,
    failure?: string,
    error?: string,
  ) {
    if (local.closed) {
      return;
    }

    local.closed = true;
    clearTimeout(local.deadlineTimer);
    clearTimeout(local.graceTimer);
    clearInterval(local.leaseTimer);
    local.meter.stop();
    local.telemetry.end({ status, failure, error });
    this.runs.delete(local.run.id);
    // The terminal transition revokes the run's tokens; this covers a run
    // closed some other way.
    void this.tokens.revoke(local.run.id);
  }

  /** The deadline, and the lease that keeps the sweep away while it works. */
  private arm(local: LocalRun, deadlineAt: number) {
    local.deadlineTimer = setTimeout(
      () => {
        void this.fail(
          local.run,
          'BUDGET_EXHAUSTED',
          'The run reached its time limit, so the server stopped it.',
          local,
        );
      },
      Math.max(deadlineAt - Date.now(), 0),
    );
    local.deadlineTimer.unref?.();

    const every = Math.max(Math.floor(AGENT_RUN_LEASE_MS / 3), 1000);

    local.leaseTimer = setInterval(() => {
      void this.agentRuns
        .renewLease(local.run.id)
        .then(async (held) => {
          if (held || local.closed) {
            return;
          }

          // Swept or cancelled: the run is over, so stop the connector.
          await this.cancel(local.run);
        })
        .catch((): undefined => undefined);
    }, every);
    local.leaseTimer.unref?.();
  }

  private runsOf(peer: ConnectorPeer): LocalRun[] {
    return [...this.runs.values()].filter(
      (local) =>
        local.peer.userId === peer.userId &&
        local.peer.workspaceId === peer.workspaceId,
    );
  }

  /**
   * The person whose machine runs this. The owner of the run's personal agent,
   * which is who delegated; the delegating member if the agent has no owner.
   */
  private async personOf(run: AgentRun): Promise<ConnectorPeer | null> {
    const membership = await this.prisma.usersOnWorkspaces.findFirst({
      where: { userId: run.agentUserId, workspaceId: run.workspaceId },
      select: { settings: true },
    });
    const userId =
      agentSettings(membership?.settings).ownerUserId ?? run.createdById;

    return userId ? { workspaceId: run.workspaceId, userId } : null;
  }

  /**
   * The repository on the person's machine, or the reason there is none.
   * Returns a string for a refusal, so the caller can fail the run with it.
   */
  private async resolveRepo(
    run: AgentRun,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: any,
  ): Promise<ConnectorRunDispatch['repo'] | string> {
    const source = config.source as
      { integrationAccountId?: string; externalRepoId?: string } | undefined;

    if (!source?.integrationAccountId || !source.externalRepoId) {
      return (
        'This run has no repository to open. Link the issue’s modules to a ' +
        'repository in Settings → Modules.'
      );
    }

    const resolved = await this.gitSources.resolve({
      workspaceId: run.workspaceId,
      integrationAccountId: source.integrationAccountId,
      externalRepoId: source.externalRepoId,
    });

    if ('unresolved' in resolved) {
      return `The issue’s repository cannot be used: ${resolved.unresolved}.`;
    }

    const path = resolved.repo.listing.path;

    if (resolved.source.slug !== LOCAL_REPO_SLUG || typeof path !== 'string') {
      return (
        `${resolved.repo.fullName} is not a local repository. A local run ` +
        'works in a directory on your machine, so the issue’s module has to ' +
        'be linked to a repository added as a local repository.'
      );
    }

    let base: string | null = config.baseBranch ?? null;

    if (!base) {
      try {
        base = (await resolved.source.defaultBranch?.(resolved.repo)) ?? null;
      } catch {
        // A directory that cannot say its default is not a reason to refuse
        // the run; `main` is what the connector tries next.
      }
    }

    return {
      id: resolved.repo.externalRepoId,
      fullName: resolved.repo.fullName,
      path,
      baseRef: String(base ?? 'main'),
    };
  }
}

/** The extension policy without the paths only the connector can fill in. */
function policyFor(
  pack: ContextPack,
  egressHosts?: string[],
  config?: unknown,
): ConnectorRunDispatch['policy'] {
  const policy = guardrailPolicy(pack, egressHosts);

  return {
    pathPrefixes: policy.pathPrefixes,
    checks: policy.checks,
    reachableHosts: policy.reachableHosts,
    maxOutputTokens: policy.maxOutputTokens ?? null,
    questionWaitMs: questionWaitMs(config),
  };
}

/**
 * The model the person chose at dispatch. An id that is not safe to pass as an
 * argument becomes null, which leaves omp on its own default.
 */
function modelOf(config: {
  provider?: string;
  model?: string;
  thinking?: string;
}): ConnectorRunDispatch['model'] {
  const safe = (value: unknown) =>
    typeof value === 'string' && isSafeModelId(value) ? value : null;

  return {
    provider: safe(config.provider),
    model: safe(config.model),
    thinking:
      config.thinking &&
      (THINKING_LEVELS as readonly string[]).includes(config.thinking)
        ? config.thinking
        : null,
  };
}

/** Every string inside a value, scrubbed of the given secrets. */
export function scrubDeep<T>(value: T, secrets: string[]): T {
  if (typeof value === 'string') {
    return scrubSecrets(value, secrets) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => scrubDeep(entry, secrets)) as T;
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        scrubDeep(entry, secrets),
      ]),
    ) as T;
  }

  return value;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value ? value.slice(0, 1000) : null;
