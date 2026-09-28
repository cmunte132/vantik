import type {
  PageEntrySignalKind,
  PageEntrySignalSource,
  Prisma,
} from '@prisma/client';

import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { PageEntryCitationKindEnum } from '@vantikhq/types';
import { Queue } from 'bull';
import { PrismaService } from 'nestjs-prisma';

import { evidencePaths } from 'modules/agent-runs/evidence-paths';
import { LoggerService } from 'modules/logger/logger.service';
import { scopePath } from 'modules/modules/module-routing';
import {
  PAGES_QUEUE,
  RECHECK_ENTRY_JOB,
  recheckEntryJobOptions,
} from 'modules/pages/pages.interface';

/** The weight of a full signal. */
export const FULL_SIGNAL = 1;

/**
 * The weight of a weak one: a pull request closed without merging. Closed
 * work says little about why, and often nothing about the knowledge.
 */
export const WEAK_SIGNAL = 0.5;

/**
 * Runs read when matching a pull request to the run that pushed its branch.
 * Branches are suffixed per run, so this is a bound, not a sample.
 */
const MAX_RUNS_PER_BRANCH = 20;

/** Run ends whose checks and review say something about the work. */
const MEASURED_ENDS = ['SUCCEEDED', 'NEEDS_REVIEW', 'FAILED'];

/** Where a pull request an agent run opened now stands. */
export type PullRequestState = 'MERGED' | 'CLOSED' | 'OPEN';

interface Signal {
  entryId: string;
  kind: PageEntrySignalKind;
  weight: number;
  evidence: string | null;
}

/** A path something went wrong in, and what said so. */
interface Evidence {
  path: string;
  what: string;
}

interface EntryShape {
  id: string;
  scope: string | null;
  citations: Array<{
    path: string | null;
    moduleRepo: { fullName: string } | null;
  }>;
}

/**
 * Turns what happened to a run's work into signals about the knowledge it
 * was handed.
 *
 * Each signal is weak and noisy: a run fails for many reasons, and most have
 * nothing to do with what it was told. They are counted, not acted on. A
 * harmful one has the entry's citations checked again, which is the one
 * thing a signal can prompt without being right; it never archives or
 * deletes anything. Retiring an entry on its counts is a later decision,
 * made on many runs rather than one.
 *
 * A run's end is read from its last recorded pass: earlier passes' findings
 * were either fixed or found again, as the executor's own report treats them.
 */
@Injectable()
export class KnowledgeSignalsService {
  private readonly logger = new LoggerService('KnowledgeSignalsService');

  constructor(
    private prisma: PrismaService,
    @InjectQueue(PAGES_QUEUE) private pagesQueue: Queue,
  ) {}

  /**
   * Attributes a run's end to each entry it was served.
   *
   * Harmful, for an entry a finding or a failing check points into: a file
   * one of its code citations names, or a path under the folder its scope
   * names. Otherwise helpful, when the checks passed and the reviewer
   * accepted the work. Otherwise nothing: a run that went wrong somewhere
   * the entry does not speak about says nothing about the entry.
   */
  async runFinished(
    runId: string,
  ): Promise<{ helpful: number; harmful: number }> {
    const run = await this.prisma.agentRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        status: true,
        config: true,
        iterations: {
          orderBy: { index: 'desc' },
          take: 1,
          select: {
            verificationPassed: true,
            accepted: true,
            findings: true,
            failedChecks: true,
          },
        },
      },
    });

    const last = run?.iterations[0];

    // A run canceled or expired, or one that never got as far as checking
    // its work, measured nothing.
    if (!run || !last || !MEASURED_ENDS.includes(run.status)) {
      return { helpful: 0, harmful: 0 };
    }

    const entries = await this.entriesServedTo(runId);

    if (!entries.length) {
      return { helpful: 0, harmful: 0 };
    }

    const evidence = evidenceOf(last);
    const repo = repoNameOf(run.config);
    const succeeded =
      last.verificationPassed === true && last.accepted === true;

    const signals: Signal[] = [];

    for (const entry of entries) {
      const against = evidence.find((item) => isUnder(entry, item.path, repo));

      if (against) {
        signals.push({
          entryId: entry.id,
          kind: 'HARMFUL',
          weight: FULL_SIGNAL,
          evidence: against.what,
        });
      } else if (succeeded) {
        signals.push({
          entryId: entry.id,
          kind: 'HELPFUL',
          weight: FULL_SIGNAL,
          evidence: null,
        });
      }
    }

    await this.apply(runId, 'RUN', signals);

    return {
      helpful: signals.filter((signal) => signal.kind === 'HELPFUL').length,
      harmful: signals.filter((signal) => signal.kind === 'HARMFUL').length,
    };
  }

  /**
   * Records what became of a pull request, on the run that opened it, and
   * signals the entries that run was served.
   *
   * Merged is helpful; closed without merging is weakly harmful; reopened
   * withdraws whichever was given. Only the run that produced the work is
   * credited: another pull request on the same issue says nothing about what
   * this run was told.
   */
  async pullRequestChanged(input: {
    workspaceId: string;
    url: string;
    state: PullRequestState;
    closedAt?: Date | null;
    branch?: string | null;
    repo?: string | null;
    openedAt?: Date | null;
  }): Promise<{ runs: number }> {
    if (!input.url) {
      return { runs: 0 };
    }

    const runs = await this.runsOfPullRequest(input);

    for (const run of runs) {
      await this.prisma.agentRun.update({
        where: { id: run.id },
        data:
          input.state === 'OPEN'
            ? { pullRequestOutcome: null, pullRequestClosedAt: null }
            : {
                pullRequestOutcome: input.state,
                pullRequestClosedAt: input.closedAt ?? new Date(),
              },
      });

      const entries = await this.entriesServedTo(run.id);

      if (input.state === 'OPEN') {
        await this.withdraw(
          run.id,
          'PULL_REQUEST',
          entries.map((entry) => entry.id),
        );
        continue;
      }

      await this.apply(
        run.id,
        'PULL_REQUEST',
        entries.map((entry) => ({
          entryId: entry.id,
          ...(input.state === 'MERGED'
            ? { kind: 'HELPFUL' as const, weight: FULL_SIGNAL, evidence: null }
            : {
                kind: 'HARMFUL' as const,
                weight: WEAK_SIGNAL,
                evidence: `${input.url} was closed without merging`,
              }),
        })),
      );
    }

    return { runs: runs.length };
  }

  // --------------------------------------------------------------- internals

  /**
   * The runs a pull request is the work of. The run that opened it, by its
   * address; or, for one a person opened from a run's branch because the run
   * pushed but could not open one itself, the newest run that pushed that
   * branch to that repository before it was opened. Newest, because a branch
   * deleted after its merge can be pushed again by a later run on the same
   * issue. A run with a pull request of its own is spoken for by that one.
   */
  private async runsOfPullRequest(input: {
    workspaceId: string;
    url: string;
    branch?: string | null;
    repo?: string | null;
    openedAt?: Date | null;
  }): Promise<Array<{ id: string }>> {
    const opened = await this.prisma.agentRun.findMany({
      where: {
        workspaceId: input.workspaceId,
        deleted: null,
        result: { path: ['prUrl'], equals: input.url },
      },
      select: { id: true },
    });

    if (!input.branch || !input.repo) {
      return opened;
    }

    const pushed = await this.prisma.agentRun.findMany({
      where: {
        workspaceId: input.workspaceId,
        deleted: null,
        result: { path: ['branch'], equals: input.branch },
        ...(input.openedAt ? { createdAt: { lte: input.openedAt } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_RUNS_PER_BRANCH,
      select: { id: true, config: true, result: true },
    });
    const repo = input.repo.toLowerCase();
    const newest = pushed.find((run) => repoNameOf(run.config) === repo);

    if (
      !newest ||
      stringField(newest.result, 'prUrl') ||
      opened.some((run) => run.id === newest.id)
    ) {
      return opened;
    }

    return [...opened, { id: newest.id }];
  }

  /** The live entries a run was served, with what places them. */
  private async entriesServedTo(runId: string): Promise<EntryShape[]> {
    const uses = await this.prisma.pageEntryUse.findMany({
      where: { agentRunId: runId },
      select: { entryId: true },
      distinct: ['entryId'],
    });

    if (!uses.length) {
      return [];
    }

    return this.prisma.pageEntry.findMany({
      where: { id: { in: uses.map((use) => use.entryId) }, deleted: null },
      select: {
        id: true,
        scope: true,
        citations: {
          where: { kind: PageEntryCitationKindEnum.CODE },
          select: { path: true, moduleRepo: { select: { fullName: true } } },
        },
      },
    });
  }

  /**
   * Writes each signal and moves its entry's counts, once.
   *
   * One row per entry, run and source. A signal already recorded as it is
   * changes nothing, so an outcome reported twice counts once; a different
   * one replaces it and the counts move by the difference. The row is only
   * replaced if it still reads as it was read, so two deliveries racing each
   * other cannot both move the counts.
   */
  private async apply(
    runId: string,
    source: PageEntrySignalSource,
    signals: Signal[],
  ): Promise<void> {
    for (const signal of signals) {
      try {
        const harmful = await this.prisma.$transaction(async (tx) => {
          const key = { entryId: signal.entryId, agentRunId: runId, source };
          const { count } = await tx.pageEntrySignal.createMany({
            data: [
              {
                ...key,
                kind: signal.kind,
                weight: signal.weight,
                evidence: signal.evidence,
              },
            ],
            skipDuplicates: true,
          });

          if (count === 1) {
            await moveCounts(tx, signal.entryId, null, signal);
            return signal.kind === 'HARMFUL';
          }

          const previous = await tx.pageEntrySignal.findUnique({
            where: { entryId_agentRunId_source: key },
            select: { id: true, kind: true, weight: true },
          });

          if (
            !previous ||
            (previous.kind === signal.kind && previous.weight === signal.weight)
          ) {
            return false;
          }

          const replaced = await tx.pageEntrySignal.updateMany({
            where: {
              id: previous.id,
              kind: previous.kind,
              weight: previous.weight,
            },
            data: {
              kind: signal.kind,
              weight: signal.weight,
              evidence: signal.evidence,
            },
          });

          if (replaced.count === 0) {
            return false;
          }

          await moveCounts(tx, signal.entryId, previous, signal);
          return signal.kind === 'HARMFUL';
        });

        if (harmful) {
          await this.queueRecheck(signal.entryId);
        }
      } catch (error) {
        this.logger.error({
          message: `A ${signal.kind.toLowerCase()} signal for entry ${signal.entryId} from run ${runId} was not recorded: ${error}`,
          where: 'KnowledgeSignalsService.apply',
          error: error instanceof Error ? error : undefined,
        });
      }
    }
  }

  /** Takes back the signals a source gave, and what they added to counts. */
  private async withdraw(
    runId: string,
    source: PageEntrySignalSource,
    entryIds: string[],
  ): Promise<void> {
    for (const entryId of entryIds) {
      await this.prisma.$transaction(async (tx) => {
        const key = { entryId, agentRunId: runId, source };
        const previous = await tx.pageEntrySignal.findUnique({
          where: { entryId_agentRunId_source: key },
          select: { id: true, kind: true, weight: true },
        });

        if (!previous) {
          return;
        }

        const { count } = await tx.pageEntrySignal.deleteMany({
          where: {
            id: previous.id,
            kind: previous.kind,
            weight: previous.weight,
          },
        });

        if (count === 1) {
          await moveCounts(tx, entryId, previous, null);
        }
      });
    }
  }

  private async queueRecheck(entryId: string): Promise<void> {
    try {
      await this.pagesQueue.add(
        RECHECK_ENTRY_JOB,
        { entryId },
        recheckEntryJobOptions(entryId),
      );
    } catch (error) {
      this.logger.error({
        message: `A re-check of entry ${entryId} could not be queued: ${error}`,
        where: 'KnowledgeSignalsService.queueRecheck',
        error: error instanceof Error ? error : undefined,
      });
    }
  }
}

/** Moves an entry's counts from one recorded signal to another. */
async function moveCounts(
  tx: Prisma.TransactionClient,
  entryId: string,
  from: { kind: PageEntrySignalKind; weight: number } | null,
  to: { kind: PageEntrySignalKind; weight: number } | null,
): Promise<void> {
  const change = { HELPFUL: 0, HARMFUL: 0 };

  if (from) {
    change[from.kind] -= from.weight;
  }

  if (to) {
    change[to.kind] += to.weight;
  }

  await tx.pageEntry.update({
    where: { id: entryId },
    data: {
      helpfulCount: { increment: change.HELPFUL },
      harmfulCount: { increment: change.HARMFUL },
    },
  });
}

/**
 * What went wrong on a pass, and where: each finding's evidence, and each
 * failing check's paths.
 */
function evidenceOf(pass: {
  findings: Prisma.JsonValue;
  failedChecks: Prisma.JsonValue;
}): Evidence[] {
  const evidence: Evidence[] = [];

  for (const finding of arrayOf(pass.findings)) {
    const cited = typeof finding.evidence === 'string' ? finding.evidence : '';

    for (const path of evidencePaths(cited)) {
      evidence.push({ path, what: `review finding at ${cited}` });
    }
  }

  for (const check of arrayOf(pass.failedChecks)) {
    const label = typeof check.label === 'string' ? check.label : 'a check';
    const paths = Array.isArray(check.paths) ? check.paths : [];

    for (const path of paths) {
      if (typeof path === 'string') {
        evidence.push({ path, what: `${label} failed in ${path}` });
      }
    }
  }

  return evidence;
}

function arrayOf(value: Prisma.JsonValue): Prisma.JsonObject[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Prisma.JsonObject =>
          item !== null && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
}

/**
 * Whether a path in the run's repository falls under an entry: a file one of
 * its code citations names (in that repository, where both are known), or a
 * path under the folder its scope names. A scope may start with the
 * repository's name, which is dropped when it is this run's.
 */
export function isUnder(
  entry: EntryShape,
  path: string,
  repo: string | null,
): boolean {
  const cited = entry.citations.some(
    (citation) =>
      citation.path === path &&
      (!repo ||
        !citation.moduleRepo ||
        citation.moduleRepo.fullName.toLowerCase() === repo),
  );

  if (cited) {
    return true;
  }

  let folder = scopePath(entry.scope);

  if (folder && repo && folder.toLowerCase().startsWith(`${repo}/`)) {
    folder = folder.slice(repo.length + 1);
  }

  return Boolean(folder) && (path === folder || path.startsWith(`${folder}/`));
}

/**
 * The name of the repository a run worked in, lower-cased: the source's full
 * name (`owner/name` on a git host). A run from before the source reference
 * named only its remote, so that is read when there is no source.
 */
export function repoNameOf(config: Prisma.JsonValue): string | null {
  const fields =
    config && typeof config === 'object' && !Array.isArray(config)
      ? config
      : null;
  const source = fields?.source;
  const fullName =
    source && typeof source === 'object' && !Array.isArray(source)
      ? source.fullName
      : null;

  if (typeof fullName === 'string' && fullName.trim()) {
    return fullName.trim().toLowerCase();
  }

  const repoUrl = fields?.repoUrl;

  if (typeof repoUrl !== 'string') {
    return null;
  }

  const match = /[/:]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(repoUrl.trim());

  return match ? match[1].toLowerCase() : null;
}

function stringField(value: Prisma.JsonValue, key: string): string | null {
  const field =
    value && typeof value === 'object' && !Array.isArray(value)
      ? value[key]
      : null;

  return typeof field === 'string' && field.length > 0 ? field : null;
}
