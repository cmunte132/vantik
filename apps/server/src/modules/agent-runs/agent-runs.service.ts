import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AGENT_RUN_TRANSITIONS,
  AgentRunFailure,
  AgentRunStatus,
  AppendAgentRunEventDto,
  canTransitionAgentRun,
  isTerminalAgentRunStatus,
  RETRYABLE_AGENT_RUN_STATUSES,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import {
  AGENT_RUN_EVENT_CAP,
  AGENT_RUN_EVENT_TRIM_SLACK,
  AGENT_RUN_LEASE_MS,
  AGENT_RUN_MAX_ATTEMPTS,
} from './agent-runs.interface';

/** Fields a caller may set as part of a transition. */
export interface TransitionPatch {
  claimedAt?: Date;
  startedAt?: Date;
  finishedAt?: Date;
  leaseExpiresAt?: Date | null;
  summary?: string;
  error?: string;
  failure?: AgentRunFailure | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result?: any;
  harnessVersion?: string;
  modelId?: string;
  baseCommit?: string;
  iterationCount?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  phaseTimings?: any;
}

/** How a read is narrowed for the principal making it. */
export interface AgentRunScope {
  workspaceId: string;
  /**
   * Set when the caller is an AGENT: it sees its own runs and nothing else.
   * A person sees the workspace's.
   */
  onlyAgentUserId?: string | null;
}

/**
 * A run the sweeper gave up on, and what is owed to it.
 *
 * Enough to write to the issue and to open the next attempt, without the
 * caller reading the row again — the sweep is the one path where the run in
 * question is by definition not going to change under it.
 */
export interface ExpiredRun {
  id: string;
  issueId: string;
  agentUserId: string;
  workspaceId: string;
  /** The attempt that lapsed, not the one that follows it. */
  attempt: number;
  retryable: boolean;
}

/**
 * A run that was handed to a backend and never started, now failed.
 *
 * Carries the error it was failed with, so what the issue is told and what
 * the run records are the same words.
 */
export interface UnstartedRun extends Omit<ExpiredRun, 'retryable'> {
  error: string;
}

export interface ListAgentRunsFilter {
  issueId?: string;
  agentUserId?: string;
  status?: AgentRunStatus[];
  executor?: string;
  page?: number;
  perPage?: number;
}

/**
 * The lifecycle of an agent run.
 *
 * Every state change in the system goes through `transition`. That is the
 * point: the legality of a move is decided in one place against one table, so
 * a backend cannot invent a path through the machine by writing the row it
 * wants. Executors are writers against this record, and writers do not get to
 * define the record's rules.
 *
 * Everything here is workspace-scoped from the first query rather than
 * filtered afterwards — the ENG-18..ENG-23 security issues all came from
 * treating tenancy as something you remember to add.
 */
@Injectable()
export class AgentRunsService {
  constructor(private prisma: PrismaService) {}

  // ------------------------------------------------------------------ reads

  async listRuns(filter: ListAgentRunsFilter, scope: AgentRunScope) {
    const page = filter.page ?? 1;
    const perPage = Math.min(filter.perPage ?? 50, 200);

    const where = this.scopeWhere(scope, {
      ...(filter.issueId ? { issueId: filter.issueId } : {}),
      ...(filter.agentUserId ? { agentUserId: filter.agentUserId } : {}),
      ...(filter.status?.length ? { status: { in: filter.status } } : {}),
      ...(filter.executor ? { executor: filter.executor } : {}),
    });

    const [items, total] = await Promise.all([
      this.prisma.agentRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.agentRun.count({ where }),
    ]);

    return { items, page, perPage, total };
  }

  // ----------------------------------------------------------------- writes

  /**
   * Opens a run in QUEUED.
   *
   * Deliberately a plain database write. trigger.dev is optional in every
   * deployment this repo ships and is absent from the compose file, so an
   * enqueue that went through `tasks.trigger(...)` would silently drop every
   * run on a stock install — which is what the existing fire-and-forget call
   * sites in issues.service do today.
   */
  async createRun(input: {
    workspaceId: string;
    issueId: string;
    agentUserId: string;
    createdById: string | null;
    executor: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config?: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contextPack?: any;
    configHash?: string;
    attempt?: number;
    previousRunId?: string;
  }) {
    return this.prisma.agentRun.create({
      data: {
        workspaceId: input.workspaceId,
        issueId: input.issueId,
        agentUserId: input.agentUserId,
        createdById: input.createdById,
        executor: input.executor,
        status: 'QUEUED',
        attempt: input.attempt ?? 1,
        previousRunId: input.previousRunId,
        config: input.config ?? undefined,
        contextPack: input.contextPack ?? undefined,
        configHash: input.configHash,
      },
    });
  }

  /**
   * Moves a run, or refuses to.
   *
   * Two guards, and they catch different things. The transition table catches
   * an illegal move — reporting success on a run that already expired. The
   * conditional update catches a legal move that lost a race: the `where`
   * names the status the caller believed the run was in, so of two writers
   * only the first finds a row, and the second is told what actually happened
   * instead of overwriting it.
   *
   * `expected.from` narrows it further, for a caller whose decision holds only
   * in one state. Without it a run that moved on between the caller's read
   * and this one is moved from wherever it now is, which is right for "this
   * run is finished" and wrong for "this run never started".
   */
  async transition(
    runId: string,
    to: AgentRunStatus,
    patch: TransitionPatch = {},
    scope?: AgentRunScope,
    expected: { from?: AgentRunStatus } = {},
  ) {
    const current = scope
      ? await this.requireRun(runId, scope)
      : await this.requireRunUnscoped(runId);

    const from = current.status as AgentRunStatus;

    if (expected.from && from !== expected.from) {
      throw new ConflictException({
        message: `Agent run ${runId} is ${from}, not ${expected.from}, so it was not moved to ${to}.`,
      });
    }

    if (from === to) {
      return current;
    }

    if (!canTransitionAgentRun(from, to)) {
      const legal = AGENT_RUN_TRANSITIONS[from];
      throw new ConflictException({
        message: isTerminalAgentRunStatus(from)
          ? `Agent run ${runId} already finished as ${from} and cannot become ${to}.`
          : `An agent run cannot go from ${from} to ${to}. From ${from} it may become: ${legal.join(', ')}.`,
      });
    }

    const { count } = await this.prisma.agentRun.updateMany({
      where: { id: runId, status: from },
      data: {
        status: to,
        ...patch,
        // Whatever the caller says, a terminal state stops the clock and drops
        // the lease. Leaving a lease on a finished run means the sweeper keeps
        // finding it.
        ...(isTerminalAgentRunStatus(to)
          ? {
              finishedAt: patch.finishedAt ?? new Date(),
              leaseExpiresAt: null,
            }
          : {}),
      },
    });

    if (count === 0) {
      const now = await this.requireRunUnscoped(runId);
      throw new ConflictException({
        message: `Agent run ${runId} moved to ${now.status} while this ${to} was in flight.`,
      });
    }

    return this.requireRunUnscoped(runId);
  }

  /**
   * Appends a progress line.
   *
   * Accepted in any non-terminal state and refused after, because an event
   * arriving for a finished run is either a confused runner or a replay, and
   * neither should be able to append to the record a human is reading.
   */
  async appendEvent(
    runId: string,
    input: AppendAgentRunEventDto,
    scope: AgentRunScope,
  ) {
    const run = await this.requireRun(runId, scope);

    if (isTerminalAgentRunStatus(run.status as AgentRunStatus)) {
      throw new ConflictException({
        message: `Agent run ${runId} already finished as ${run.status}; it accepts no more events.`,
      });
    }

    const event = await this.prisma.agentRunEvent.create({
      data: {
        runId,
        message: input.message,
        level: input.level ?? 'INFO',
        phase: input.phase,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: (input.data ?? undefined) as any,
        at: input.at ? new Date(input.at) : new Date(),
      },
    });

    await this.trimEvents(runId);

    return event;
  }

  /**
   * Drops the oldest events once a run is meaningfully over the cap.
   *
   * Counted with slack rather than trimmed on every append: a chatty harness
   * writes several lines a second, and a delete-one-per-insert would double
   * the write cost of every one of them to save nothing.
   */
  private async trimEvents(runId: string) {
    const total = await this.prisma.agentRunEvent.count({ where: { runId } });

    if (total <= AGENT_RUN_EVENT_CAP + AGENT_RUN_EVENT_TRIM_SLACK) {
      return;
    }

    const stale = await this.prisma.agentRunEvent.findMany({
      where: { runId },
      orderBy: { at: 'asc' },
      take: total - AGENT_RUN_EVENT_CAP,
      select: { id: true },
    });

    await this.prisma.agentRunEvent.deleteMany({
      where: { id: { in: stale.map((event) => event.id) } },
    });
  }

  /**
   * Records one pass of the ENG-62 loop.
   *
   * Δ is computed here from the two pass rates rather than accepted from the
   * caller. It is the reward-hacking metric, and a metric supplied by the
   * party being measured is not a metric — the runner reports what its suites
   * scored, and the server decides what that means.
   */
  async recordIteration(
    runId: string,
    input: {
      index: number;
      validationPassRate?: number;
      heldOutPassRate?: number;
      verificationPassed?: boolean;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findings?: any;
      diffHash?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      phaseTimings?: any;
    },
    scope: AgentRunScope,
  ) {
    await this.requireRun(runId, scope);

    const delta =
      input.validationPassRate != null && input.heldOutPassRate != null
        ? input.validationPassRate - input.heldOutPassRate
        : null;

    const iteration = await this.prisma.agentRunIteration.upsert({
      where: { runId_index: { runId, index: input.index } },
      create: {
        runId,
        index: input.index,
        validationPassRate: input.validationPassRate,
        heldOutPassRate: input.heldOutPassRate,
        delta,
        verificationPassed: input.verificationPassed,
        findings: input.findings ?? undefined,
        diffHash: input.diffHash,
        phaseTimings: input.phaseTimings ?? undefined,
      },
      update: {
        validationPassRate: input.validationPassRate,
        heldOutPassRate: input.heldOutPassRate,
        delta,
        verificationPassed: input.verificationPassed,
        findings: input.findings ?? undefined,
        diffHash: input.diffHash,
        phaseTimings: input.phaseTimings ?? undefined,
      },
    });

    // Kept on the run too, so "how many passes did this take" is answerable
    // without joining.
    await this.prisma.agentRun.updateMany({
      where: { id: runId },
      data: { iterationCount: input.index },
    });

    return iteration;
  }

  async cancelRun(runId: string, scope: AgentRunScope, reason?: string) {
    return this.transition(
      runId,
      'CANCELED',
      { error: reason ?? 'Canceled.' },
      scope,
    );
  }

  /**
   * Opens a fresh attempt at the same issue.
   *
   * A new row rather than a reset one. An attempt that failed three quarters
   * of the way through is evidence, and evidence overwritten on retry is
   * evidence nobody has when the third attempt fails the same way.
   */
  async retryRun(runId: string, scope: AgentRunScope, createdById: string) {
    const previous = await this.requireRun(runId, scope);
    const status = previous.status as AgentRunStatus;

    if (!RETRYABLE_AGENT_RUN_STATUSES.includes(status)) {
      throw new ConflictException({
        message: isTerminalAgentRunStatus(status)
          ? `Agent run ${runId} finished as ${status}; retrying it would duplicate work that was not asked for.`
          : `Agent run ${runId} is still ${status}. Cancel it before retrying.`,
      });
    }

    if (previous.attempt >= AGENT_RUN_MAX_ATTEMPTS) {
      throw new BadRequestException({
        message:
          `Agent run ${runId} is attempt ${previous.attempt} of ` +
          `${AGENT_RUN_MAX_ATTEMPTS}. The same environment failing the same ` +
          `way is a broken configuration rather than bad luck — fix the ` +
          `config and delegate again.`,
      });
    }

    // One retry per run, enforced by a unique index, so a chain of attempts
    // cannot fork into two branches nobody reconciles.
    const existing = await this.prisma.agentRun.findUnique({
      where: { previousRunId: runId },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException({
        message: `Agent run ${runId} has already been retried as ${existing.id}.`,
      });
    }

    return this.createRun({
      workspaceId: previous.workspaceId,
      issueId: previous.issueId,
      agentUserId: previous.agentUserId,
      createdById,
      executor: previous.executor,
      config: previous.config ?? undefined,
      contextPack: previous.contextPack ?? undefined,
      configHash: previous.configHash ?? undefined,
      attempt: previous.attempt + 1,
      previousRunId: previous.id,
    });
  }

  // ---------------------------------------------------------------- sweeper

  /**
   * Extends a live run's lease, and says whether it is still the run's to
   * extend.
   *
   * The half of the lease protocol that runs beside the work. Conditional on
   * the run still being CLAIMED or RUNNING, so a run that was cancelled or
   * swept out from under its executor cannot be quietly resurrected by a
   * renewal that arrived a moment later.
   *
   * The `false` is the point, not a detail: it is how work in flight finds
   * out it has been given up on. An executor that keeps going after losing
   * its lease is spending model budget on a result the server has already
   * decided nothing will accept, beside a fresh attempt at the same issue.
   */
  async renewLease(runId: string, now = new Date()): Promise<boolean> {
    const { count } = await this.prisma.agentRun.updateMany({
      where: { id: runId, status: { in: ['CLAIMED', 'RUNNING'] } },
      data: { leaseExpiresAt: new Date(now.getTime() + AGENT_RUN_LEASE_MS) },
    });

    return count > 0;
  }

  /**
   * Expires runs whose lease has lapsed.
   *
   * Server-side and unconditional: a run that has stopped cannot report that
   * it stopped, which is exactly the case this exists for. Runs are expired
   * one at a time through `transition` rather than in a bulk update, so work
   * that renews its lease during the sweep loses the race cleanly instead of
   * being expired out from under it.
   *
   * Expiring is all this does. What each expired run then needs — a word on
   * its issue, a fresh attempt actually handed to a backend — belongs to the
   * layers that own those, so it returns enough about each run for the caller
   * to do them and stays a state machine.
   */
  async expireLapsedLeases(now = new Date()): Promise<ExpiredRun[]> {
    const lapsed = await this.prisma.agentRun.findMany({
      where: {
        status: { in: ['CLAIMED', 'RUNNING'] },
        leaseExpiresAt: { not: null, lt: now },
      },
      select: {
        id: true,
        attempt: true,
        issueId: true,
        agentUserId: true,
        workspaceId: true,
      },
    });

    const expired: ExpiredRun[] = [];

    for (const run of lapsed) {
      try {
        await this.transition(run.id, 'EXPIRED', {
          failure: 'LEASE_LOST',
          error: 'The run stopped renewing its lease.',
        });
      } catch {
        // Lost the race to a renewal or a finished run. That is the correct
        // outcome, not an error — the run is alive after all.
        continue;
      }

      expired.push({
        id: run.id,
        issueId: run.issueId,
        agentUserId: run.agentUserId,
        workspaceId: run.workspaceId,
        attempt: run.attempt,
        retryable: run.attempt < AGENT_RUN_MAX_ATTEMPTS,
      });
    }

    return expired;
  }

  /**
   * Fails runs that were handed to a backend and never started.
   *
   * Every executor is push-based now: dispatch starts the work, and the run
   * leaves QUEUED within seconds, when the executor claims it. A run still
   * QUEUED a whole lease later was dropped on the way, most often by a
   * restart between dispatch and claim. Nothing polls the queue, so nothing
   * would ever pick it up, and it would hold a slot against the workspace cap
   * and block its own issue from being delegated again.
   *
   * Failed rather than dispatched again, so a person decides whether to spend
   * the model budget twice. Aged out here rather than failed at boot, for the
   * reason the lease replaced boot-time reconciling: a booting replica cannot
   * tell a run that another replica dispatched a moment ago from one that was
   * lost, and a lease's worth of age can.
   *
   * Pinned to QUEUED, so a run claimed between the read and the write is left
   * to finish rather than failed while it works.
   */
  async failUnstartedRuns(now = new Date()): Promise<UnstartedRun[]> {
    const stale = await this.prisma.agentRun.findMany({
      where: {
        status: 'QUEUED',
        deleted: null,
        createdAt: { lt: new Date(now.getTime() - AGENT_RUN_LEASE_MS) },
      },
      select: {
        id: true,
        attempt: true,
        issueId: true,
        agentUserId: true,
        workspaceId: true,
        executor: true,
      },
    });

    const minutes = Math.round(AGENT_RUN_LEASE_MS / 60_000);
    const failed: UnstartedRun[] = [];

    for (const run of stale) {
      const error =
        `Nothing started this run. It was still queued ${minutes} minutes ` +
        `after it was handed to the ${run.executor} executor, which usually ` +
        'means the server restarted in between. Retry it to run it again.';

      try {
        await this.transition(
          run.id,
          'FAILED',
          { failure: 'LEASE_LOST', error },
          undefined,
          { from: 'QUEUED' },
        );
      } catch {
        // Claimed, cancelled or failed since the read. Whatever it became,
        // it is no longer a run nobody started.
        continue;
      }

      failed.push({
        id: run.id,
        issueId: run.issueId,
        agentUserId: run.agentUserId,
        workspaceId: run.workspaceId,
        attempt: run.attempt,
        error,
      });
    }

    return failed;
  }

  // --------------------------------------------------------------- internal

  /**
   * The tenancy predicate every read is built from.
   *
   * An AGENT token sees its own runs and nothing else. It has no business
   * reading what another agent is doing in the same workspace, and an agent
   * that can enumerate the workspace's runs can enumerate its issues by proxy.
   */
  private scopeWhere(
    scope: AgentRunScope,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extra: Record<string, any> = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Record<string, any> {
    return {
      workspaceId: scope.workspaceId,
      deleted: null,
      ...(scope.onlyAgentUserId ? { agentUserId: scope.onlyAgentUserId } : {}),
      ...extra,
    };
  }

  private async requireRun(runId: string, scope: AgentRunScope) {
    const run = await this.prisma.agentRun.findFirst({
      where: this.scopeWhere(scope, { id: runId }),
    });

    if (!run) {
      throw new NotFoundException({ message: `Agent run ${runId} not found` });
    }

    return run;
  }

  /**
   * For the sweeper and for re-reading a row this service has already proven
   * the caller may touch. Never reachable from a request without a scoped read
   * happening first.
   */
  private async requireRunUnscoped(runId: string) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: runId } });

    if (!run) {
      throw new NotFoundException({ message: `Agent run ${runId} not found` });
    }

    return run;
  }
}
