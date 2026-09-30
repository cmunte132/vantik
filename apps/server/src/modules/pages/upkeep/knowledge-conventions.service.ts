import { InjectQueue } from '@nestjs/bull';
import { HttpException, Injectable } from '@nestjs/common';
import {
  PageEntryKind,
  PageEntryMaintenanceAction,
  PageEntryMaintenanceReason,
  PageEntryPolicy,
  PageEntryProposalState,
  PageEntryStatus,
  PageLinkType,
  type Prisma,
} from '@prisma/client';
import {
  PageEntryKindEnum,
  type PageEntryCitationInputDto,
} from '@vantikhq/types';
import { Queue } from 'bull';
import { PrismaService } from 'nestjs-prisma';

import { entryPlace } from 'common/page-entry-where';

import { evidencePaths } from 'modules/agent-runs/evidence-paths';
import {
  ensureIntegrationBot,
  integrationBotEmail,
} from 'modules/integration-events/integration-bot';
import { repoNameOf } from 'modules/knowledge-signals/knowledge-signals.service';
import { LoggerService } from 'modules/logger/logger.service';
import { pathBelongsToModule } from 'modules/modules/module-routing';

import EntryCitationsService from '../entry-citations.service';
import { knowledgeSettings } from '../knowledge-settings';
import PageEntriesService from '../page-entries.service';
import {
  PAGES_QUEUE,
  RUN_FINDINGS_JOB,
  runFindingsJobOptions,
  STANDING_ENTRY_DECAY_DAYS,
} from '../pages.interface';
import PagesService from '../pages.service';
import {
  distinctRuns,
  findingKey,
  findingWords,
  groupFindings,
  likeness,
  lineOf,
  moduleOfPath,
  representative,
  SAME_FINDING,
} from './findings';
import KnowledgeIssues, { KNOWLEDGE_BOT } from './knowledge-issues';
import KnowledgeUpkeepService from './knowledge-upkeep.service';
import { IN_USE, type MaintenanceEvidence } from './maintenance';
import { redactSecrets } from '../triage/triage-policy';

/** Run ends whose review said something about the work, as for signals. */
const REVIEWED_ENDS = ['SUCCEEDED', 'NEEDS_REVIEW', 'FAILED'];

/** The newest findings of a module read when grouping. */
const MAX_GROUPED_FINDINGS = 500;

/**
 * How many of the runs that gave a finding a candidate cites, newest first,
 * and how many places in the code. Together within the ten citations an
 * entry may carry.
 */
const MAX_RUN_CITATIONS = 6;
const MAX_CODE_CITATIONS = 4;

/** How much of a reviewer's message is kept: one finding is a sentence. */
const MAX_MESSAGE = 600;
const MAX_EVIDENCE = 500;

/** Harmful outcomes quoted in the issue a switched-off convention opens. */
const MAX_QUOTED_SIGNALS = 10;

/** The page candidates go on when no page is linked to their module. */
export const CONVENTIONS_PAGE_TITLE = 'Conventions from review';

/**
 * How long the lock may be held while candidates are written, which reads
 * the cited code, and how long a second writer waits for a connection.
 */
const WRITE_TIMEOUT_MS = 120_000;
const WRITE_MAX_WAIT_MS = 10_000;

const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;

/** One recorded finding, as grouping and writing read it. */
interface Finding {
  id: string;
  agentRunId: string;
  words: string[];
  message: string;
  path: string | null;
  line: number | null;
  createdAt: Date;
}

/** What weighing a convention's outcomes did. */
export type Weighed = 'ARCHIVED' | 'PROPOSED' | null;

/**
 * Turns what reviewers keep telling agents into conventions, and takes a
 * convention back out of use when runs given it keep going wrong.
 *
 * At the end of every run, each review finding is recorded against the
 * module its evidence is in. Findings that say the same thing, in the words
 * `findings.ts` compares, are grouped per module across runs; once a group
 * spans `KNOWLEDGE_CONVENTION_MIN_RUNS` separate runs, a candidate CONVENTION
 * is written with the runs and the code the findings pointed at as its
 * citations. It is written as the gardener's bot, never as standing, so it
 * waits in the inbox and goes through triage like an agent's entry. Triage
 * never accepts a convention alone (PIN_REQUEST): accepting one hands it to
 * every run in its modules, so a person decides. Once accepted it is served
 * both ways, to every run in its modules and to searches it matches.
 *
 * A convention the gardener wrote is weighed after each harmful outcome:
 * when harmful outcomes, counted since a person last put it back, outnumber
 * helpful ones by `KNOWLEDGE_CONVENTION_HARM_MARGIN`, it is archived with the
 * counts as its reason and an issue tells the module's team. A person can
 * put it back. A verified one, or one on a locked page, is not archived; an
 * archive proposal asks a person instead. Outcomes take nothing else out of
 * use.
 */
@Injectable()
export default class KnowledgeConventionsService {
  private readonly logger = new LoggerService('KnowledgeConventionsService');

  constructor(
    private prisma: PrismaService,
    private entries: PageEntriesService,
    private pages: PagesService,
    private citations: EntryCitationsService,
    private upkeep: KnowledgeUpkeepService,
    private issues: KnowledgeIssues,
    @InjectQueue(PAGES_QUEUE) private pagesQueue: Queue,
  ) {}

  /**
   * Queues the recording of a finished run's findings. Bookkeeping: a run's
   * end is never held up or refused for it, and a job that cannot be queued
   * loses that run's findings, not the run.
   */
  async findingsLater(runId: string): Promise<void> {
    try {
      await this.pagesQueue.add(
        RUN_FINDINGS_JOB,
        { runId },
        runFindingsJobOptions(runId),
      );
    } catch (error) {
      this.logger.error({
        message: `The review findings of run ${runId} could not be queued: ${error}`,
        where: 'KnowledgeConventionsService.findingsLater',
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Records a finished run's review findings, from every pass, and writes a
   * candidate for each group of findings that now spans enough runs. A
   * finding whose evidence is in no module's code is not recorded: there is
   * no module to hold its convention.
   */
  async runFinished(
    runId: string,
  ): Promise<{ recorded: number; candidates: string[] }> {
    const run = await this.prisma.agentRun.findFirst({
      where: { id: runId, deleted: null },
      select: {
        id: true,
        workspaceId: true,
        status: true,
        config: true,
        iterations: {
          orderBy: { index: 'asc' },
          select: { findings: true },
        },
      },
    });

    if (!run || !REVIEWED_ENDS.includes(run.status)) {
      return { recorded: 0, candidates: [] };
    }

    const mappings = await this.mappingsFor(
      run.workspaceId,
      repoNameOf(run.config),
    );
    const rows: Prisma.KnowledgeFindingCreateManyInput[] = [];
    const keys = new Set<string>();

    for (const pass of run.iterations) {
      for (const finding of objectsIn(pass.findings)) {
        const message = oneLine(
          redactSecrets(stringField(finding.message)),
        ).slice(0, MAX_MESSAGE);
        const evidence = stringField(finding.evidence);
        const words = findingWords(message);
        const placed = evidencePaths(evidence)
          .map((path) => ({ path, moduleId: moduleOfPath(mappings, path) }))
          .find((candidate) => candidate.moduleId);

        if (!words.length || !placed?.moduleId) {
          continue;
        }

        const key = findingKey(placed.moduleId, words);

        if (keys.has(key)) {
          continue;
        }

        keys.add(key);
        rows.push({
          workspaceId: run.workspaceId,
          moduleId: placed.moduleId,
          agentRunId: run.id,
          message,
          words,
          key,
          evidence: redactSecrets(evidence).slice(0, MAX_EVIDENCE) || null,
          path: placed.path,
          line: lineOf(evidence, placed.path),
        });
      }
    }

    if (rows.length) {
      await this.prisma.knowledgeFinding.createMany({
        data: rows,
        skipDuplicates: true,
      });
    }

    const candidates: string[] = [];

    for (const moduleId of new Set(rows.map((row) => row.moduleId))) {
      candidates.push(...(await this.propose(run.workspaceId, moduleId)));
    }

    this.logger.info({
      message:
        `Recorded ${rows.length} review finding(s) of run ${run.id}; ` +
        `${candidates.length} convention(s) proposed`,
      where: 'KnowledgeConventionsService.runFinished',
    });

    return { recorded: rows.length, candidates };
  }

  /**
   * Writes a candidate for each group of a module's findings that spans
   * enough runs, and returns the entries written. Looked at without a lock
   * first, since most runs end with nothing to write; then again under the
   * workspace's lock, because two runs ending together would otherwise both
   * see the same group and both write it.
   */
  async propose(workspaceId: string, moduleId: string): Promise<string[]> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { preferences: true },
    });
    const { conventionMinRuns } = knowledgeSettings(workspace?.preferences);

    if (!(await this.ready(workspaceId, moduleId, conventionMinRuns)).length) {
      return [];
    }

    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`knowledge-conventions:${workspaceId}`}, 0))`;

        const written: string[] = [];

        for (const group of await this.ready(
          workspaceId,
          moduleId,
          conventionMinRuns,
        )) {
          const id = await this.write(workspaceId, moduleId, group);

          if (id) {
            written.push(id);
          }
        }

        return written;
      },
      { timeout: WRITE_TIMEOUT_MS, maxWait: WRITE_MAX_WAIT_MS },
    );
  }

  /**
   * Weighs the outcomes of a convention the gardener wrote, and takes it out
   * of use when harm outnumbers help by the margin. Counted from the last
   * time a person put it back, or declined to archive it for its outcomes:
   * what came before, they have already weighed. Anything else is left as it
   * is.
   */
  async weigh(entryId: string): Promise<Weighed> {
    // In use: standing, or consolidated, which is still served (pinned to
    // its modules' runs, as its page's evidence) and so still weighed.
    const entry = await this.prisma.pageEntry.findFirst({
      where: {
        id: entryId,
        deleted: null,
        status: { in: IN_USE },
        kind: PageEntryKind.CONVENTION,
      },
      select: {
        id: true,
        status: true,
        verifiedAt: true,
        sourceUserId: true,
        workspaceId: true,
        workspace: { select: { preferences: true } },
        page: { select: { entryPolicy: true } },
      },
    });

    if (!entry?.sourceUserId) {
      return null;
    }

    const workspaceId = entry.workspaceId;
    const gardener = await this.prisma.user.findUnique({
      where: { email: integrationBotEmail(KNOWLEDGE_BOT.slug, workspaceId) },
      select: { id: true },
    });

    if (!gardener || gardener.id !== entry.sourceUserId) {
      return null;
    }

    const margin = knowledgeSettings(
      entry.workspace.preferences,
    ).conventionHarmMargin;
    const since = await this.lastWeighedByPerson(entryId);
    const signals = await this.prisma.pageEntrySignal.findMany({
      where: { entryId, ...(since ? { createdAt: { gt: since } } : {}) },
      select: { kind: true, weight: true },
    });
    const total = (kind: string) =>
      signals
        .filter((signal) => signal.kind === kind)
        .reduce((sum, signal) => sum + signal.weight, 0);
    const harmful = total('HARMFUL');
    const helpful = total('HELPFUL');

    if (harmful - helpful < margin) {
      return null;
    }

    const evidence: MaintenanceEvidence = {
      harmful,
      helpful,
      margin,
      since: since?.toISOString() ?? null,
    };

    const done = await this.prisma.$transaction(async (tx) => {
      // A person vouched for it, folded it into its page's body (which a
      // person then corrects too), or keeps its page by hand: asked, not
      // done.
      if (
        entry.verifiedAt ||
        entry.status === PageEntryStatus.CONSOLIDATED ||
        entry.page?.entryPolicy === PageEntryPolicy.LOCKED
      ) {
        const asked = await this.upkeep.propose(tx, {
          workspaceId,
          entryId,
          reason: PageEntryMaintenanceReason.HARMFUL_SIGNALS,
          evidence,
        });

        return asked ? { outcome: 'PROPOSED' as const, rowId: asked.id } : null;
      }

      const { count } = await tx.pageEntry.updateMany({
        where: {
          id: entryId,
          deleted: null,
          status: PageEntryStatus.STANDING,
          verifiedAt: null,
        },
        data: { status: PageEntryStatus.ARCHIVED },
      });

      if (count === 0) {
        return null;
      }

      const row = await tx.pageEntryMaintenance.create({
        data: {
          workspaceId,
          entryId,
          action: PageEntryMaintenanceAction.ARCHIVED,
          reason: PageEntryMaintenanceReason.HARMFUL_SIGNALS,
          evidence: evidence as Prisma.InputJsonValue,
        },
        select: { id: true },
      });

      return { outcome: 'ARCHIVED' as const, rowId: row.id };
    });

    if (done?.outcome === 'ARCHIVED') {
      await this.openSwitchedOffIssue(done.rowId, since);
    }

    this.logger.info({
      message:
        `Convention ${entryId}: ${harmful} harmful and ${helpful} helpful ` +
        `outcome(s) against a margin of ${margin}; ` +
        `${done?.outcome.toLowerCase() ?? 'left as it is'}`,
      where: 'KnowledgeConventionsService.weigh',
    });

    return done?.outcome ?? null;
  }

  // --------------------------------------------------------------- internals

  /**
   * The module mappings a run's evidence is placed by: those of the
   * repository it worked in. A run on a checkout names no repository, and
   * is placed only when the workspace has one repository to place it in.
   */
  private async mappingsFor(workspaceId: string, repo: string | null) {
    const rows = await this.prisma.moduleRepo.findMany({
      where: { deleted: null, module: { workspaceId, deleted: null } },
      orderBy: { createdAt: 'asc' },
      select: { moduleId: true, pathPrefixes: true, fullName: true },
    });

    if (repo) {
      return rows.filter((row) => row.fullName.toLowerCase() === repo);
    }

    return new Set(rows.map((row) => row.fullName.toLowerCase())).size === 1
      ? rows
      : [];
  }

  /**
   * The groups of a module's findings, not yet written up, that span enough
   * runs. None for a module since deleted, whose findings wait with it.
   */
  private async ready(
    workspaceId: string,
    moduleId: string,
    minRuns: number,
  ): Promise<Finding[][]> {
    const live = await this.prisma.module.count({
      where: { id: moduleId, workspaceId, deleted: null },
    });

    if (!live) {
      return [];
    }

    const findings = await this.prisma.knowledgeFinding.findMany({
      where: {
        workspaceId,
        moduleId,
        candidateId: null,
        agentRun: { deleted: null },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_GROUPED_FINDINGS,
      select: {
        id: true,
        agentRunId: true,
        words: true,
        message: true,
        path: true,
        line: true,
        createdAt: true,
      },
    });

    return groupFindings(findings).filter(
      (group) => distinctRuns(group) >= minRuns,
    );
  }

  /**
   * Writes one group up as a candidate, and links its findings to it so
   * they are never written up again. A group like a candidate already
   * written, in use, waiting, or taken out of use within the decay window,
   * is linked to that one instead: a person has it in front of them or has
   * already said no. So is a group the page already holds, which is what
   * the write is refused with. The entry written, or null.
   */
  private async write(
    workspaceId: string,
    moduleId: string,
    group: Finding[],
  ): Promise<string | null> {
    const stands = representative(group);
    const known = await this.prisma.knowledgeFinding.findMany({
      where: {
        workspaceId,
        moduleId,
        candidateId: { not: null },
        candidate: {
          deleted: null,
          OR: [
            {
              // Waiting, or in use: standing or consolidated.
              status: { in: [PageEntryStatus.PROPOSED, ...IN_USE] },
            },
            { updatedAt: { gte: daysAgo(STANDING_ENTRY_DECAY_DAYS) } },
          ],
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_GROUPED_FINDINGS,
      select: { candidateId: true, words: true },
    });
    const like = known.find(
      (finding) => likeness(finding.words, stands.words) >= SAME_FINDING,
    );

    if (like?.candidateId) {
      await this.link(group, like.candidateId);
      return null;
    }

    const module = await this.prisma.module.findFirst({
      where: { id: moduleId, workspaceId, deleted: null },
      select: {
        name: true,
        repos: {
          where: { deleted: null },
          orderBy: { createdAt: 'asc' },
          select: { fullName: true, pathPrefixes: true },
        },
      },
    });

    if (!module) {
      return null;
    }

    const botId = await ensureIntegrationBot(
      this.prisma,
      workspaceId,
      KNOWLEDGE_BOT,
    );
    const pageId = await this.pageFor(workspaceId, moduleId, botId);
    const newestFirst = [...group].reverse();
    const runIds = [...new Set(newestFirst.map((f) => f.agentRunId))];
    const runs = new Map(
      (
        await this.prisma.agentRun.findMany({
          where: { id: { in: runIds } },
          select: { id: true, config: true, result: true },
        })
      ).map((run) => [
        run.id,
        {
          repo: repoNameOf(run.config),
          headCommit: stringField(objectOf(run.result).headCommit),
        },
      ]),
    );
    const citations: PageEntryCitationInputDto[] = [
      ...runIds.slice(0, MAX_RUN_CITATIONS).map((run) => ({ run })),
      ...(await this.codeCitations(workspaceId, newestFirst, runs)),
    ];

    try {
      const entry = await this.entries.createEntry(
        pageId,
        { userId: botId, tokenId: null },
        {
          content:
            `Review found this in ${runIds.length} separate agent runs on ` +
            `${module.name}: ${stands.message}`,
          kind: PageEntryKindEnum.CONVENTION,
          scope: scopeOf(
            module.repos,
            group.map((f) => ({
              repo: runs.get(f.agentRunId)?.repo ?? null,
              path: f.path,
            })),
          ),
          citations,
        },
      );

      await this.link(group, entry.id);
      return entry.id;
    } catch (error) {
      if (!(error instanceof HttpException)) {
        throw error;
      }

      const near = nearMatchOf(error);

      if (near) {
        await this.link(group, near);
        return null;
      }

      // The gardener's inbox on the page is full, or the page was locked
      // since it was picked: tried again at the next run in the module.
      this.logger.warn({
        message: `A convention for module ${moduleId} was not written: ${error.message}`,
        where: 'KnowledgeConventionsService.write',
      });
      return null;
    }
  }

  /**
   * The code the findings pointed at, as citations that hold: each file and
   * line read at the commit its run ended at, newest finding first. One
   * that cannot be read there (a line past the end, a commit the repository
   * never received) is left out rather than refusing the candidate.
   */
  private async codeCitations(
    workspaceId: string,
    findings: Finding[],
    runs: Map<string, { repo: string | null; headCommit: string }>,
  ): Promise<PageEntryCitationInputDto[]> {
    const cited: PageEntryCitationInputDto[] = [];
    const places = new Set<string>();

    for (const finding of findings) {
      if (cited.length >= MAX_CODE_CITATIONS) {
        break;
      }

      if (!finding.path || !finding.line) {
        continue;
      }

      const place = `${finding.path}:${finding.line}`;

      if (places.has(place)) {
        continue;
      }

      places.add(place);

      const run = runs.get(finding.agentRunId);
      const repo = run?.repo ?? null;
      const sha = run?.headCommit ?? '';
      const input: PageEntryCitationInputDto = {
        path: finding.path,
        lines: String(finding.line),
        ...(repo ? { repo } : {}),
        ...(COMMIT_SHA.test(sha) ? { sha } : {}),
      };

      try {
        await this.citations.checkForWrite(workspaceId, [input]);
        cited.push(input);
      } catch (error) {
        if (!(error instanceof HttpException)) {
          throw error;
        }
      }
    }

    return cited;
  }

  /**
   * Where a module's candidates are written: the oldest page linked to the
   * module that people have not locked, else the workspace's page of
   * conventions from review, made on first use by the gardener.
   */
  private async pageFor(
    workspaceId: string,
    moduleId: string,
    botId: string,
  ): Promise<string> {
    const linked = await this.prisma.pageLink.findFirst({
      where: {
        entityType: PageLinkType.MODULE,
        entityId: moduleId,
        deleted: null,
        page: {
          workspaceId,
          deleted: null,
          entryPolicy: { not: PageEntryPolicy.LOCKED },
        },
      },
      orderBy: { createdAt: 'asc' },
      select: { pageId: true },
    });

    if (linked) {
      return linked.pageId;
    }

    const own = await this.prisma.page.findFirst({
      where: {
        workspaceId,
        deleted: null,
        title: CONVENTIONS_PAGE_TITLE,
        createdById: botId,
        entryPolicy: { not: PageEntryPolicy.LOCKED },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    if (own) {
      return own.id;
    }

    const made = await this.pages.createPage(workspaceId, botId, {
      title: CONVENTIONS_PAGE_TITLE,
      descriptionMarkdown:
        'Conventions the knowledge gardener proposed from review findings ' +
        'that kept coming back across agent runs. Each waits for a person: ' +
        'accepting one hands it to every run in its modules.',
    });

    return made.id;
  }

  private async link(group: Finding[], candidateId: string): Promise<void> {
    await this.prisma.knowledgeFinding.updateMany({
      where: { id: { in: group.map((f) => f.id) }, candidateId: null },
      data: { candidateId },
    });
  }

  /**
   * When a person last weighed this entry's standing: put it back after the
   * gardener took it out of use, or declined to archive it for its outcomes.
   */
  private async lastWeighedByPerson(entryId: string): Promise<Date | null> {
    const rows = await this.prisma.pageEntryMaintenance.findMany({
      where: {
        entryId,
        OR: [
          { reversedAt: { not: null } },
          {
            reason: PageEntryMaintenanceReason.HARMFUL_SIGNALS,
            proposalState: PageEntryProposalState.DECLINED,
          },
        ],
      },
      select: { reversedAt: true, resolvedAt: true },
    });
    const times = rows
      .flatMap((row) => [row.reversedAt, row.resolvedAt])
      .filter((time): time is Date => time instanceof Date)
      .map((time) => time.getTime());

    return times.length ? new Date(Math.max(...times)) : null;
  }

  /**
   * Tells the module's team a convention was switched off, with the counts
   * and what the harmful outcomes pointed at, so a person can put it back if
   * the runs went wrong for another reason. Best effort: the archive stands
   * with its reason recorded either way.
   */
  private async openSwitchedOffIssue(
    rowId: string,
    since: Date | null,
  ): Promise<void> {
    try {
      const row = await this.prisma.pageEntryMaintenance.findUnique({
        where: { id: rowId },
        select: {
          workspaceId: true,
          evidence: true,
          entry: {
            select: {
              id: true,
              content: true,
              moduleIds: true,
              page: { select: { title: true } },
            },
          },
        },
      });

      if (!row) {
        return;
      }

      const evidence = (row.evidence ?? {}) as MaintenanceEvidence;
      const harms = await this.prisma.pageEntrySignal.findMany({
        where: {
          entryId: row.entry.id,
          kind: 'HARMFUL',
          ...(since ? { createdAt: { gt: since } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: MAX_QUOTED_SIGNALS,
        select: { agentRunId: true, evidence: true },
      });
      const excerpt = oneLine(redactSecrets(row.entry.content)).slice(0, 80);
      const markdown = [
        `The knowledge gardener archived a convention it had proposed, because ` +
          `runs given it went wrong more often than right: ` +
          `${evidence.harmful ?? 0} harmful and ${evidence.helpful ?? 0} ` +
          `helpful outcome(s), against a margin of ${evidence.margin ?? 0}` +
          `${since ? ` since ${since.toISOString()}` : ''}.`,
        '',
        `> ${oneLine(redactSecrets(row.entry.content))}`,
        '',
        `Entry \`${row.entry.id}\` ${entryPlace(row.entry.page)}. ` +
          'It is no longer handed to runs. If the runs went wrong for another ' +
          'reason, set it back to standing on its page, and its outcomes are ' +
          'counted afresh from then.',
        ...(harms.length
          ? [
              '',
              'What the harmful outcomes pointed at:',
              '',
              ...harms.map(
                (harm) =>
                  `- run \`${harm.agentRunId}\`: ${oneLine(
                    redactSecrets(harm.evidence ?? 'no evidence recorded'),
                  )}`,
              ),
            ]
          : []),
      ].join('\n');

      const issue = await this.issues.open({
        workspaceId: row.workspaceId,
        moduleIds: row.entry.moduleIds,
        title: `A convention was switched off after runs went wrong: ${excerpt}`,
        markdown,
      });

      if (issue) {
        await this.prisma.pageEntryMaintenance.update({
          where: { id: rowId },
          data: { issueId: issue.id },
        });
      }
    } catch (error) {
      this.logger.error({
        message: `The issue for switched-off convention row ${rowId} was not opened: ${error}`,
        where: 'KnowledgeConventionsService.openSwitchedOffIssue',
        error: error instanceof Error ? error : undefined,
      });
    }
  }
}

/**
 * The scope a module's candidate is written with, so it resolves to that
 * module: the repository and folder most of the findings are in, or the
 * repository alone for a module that is the whole of it. A finding counts
 * for a folder of the repository its run worked in; one from a checkout,
 * which names no repository, for any.
 */
export function scopeOf(
  repos: Array<{ fullName: string; pathPrefixes: string[] }>,
  places: Array<{ repo: string | null; path: string | null }>,
): string | undefined {
  let best: { scope: string; count: number } | null = null;

  for (const repo of repos) {
    const prefixes = repo.pathPrefixes.length ? repo.pathPrefixes : [''];
    const name = repo.fullName.toLowerCase();

    for (const prefix of prefixes) {
      const folder = prefix.replace(/^\/+|\/+$/g, '');
      const count = places.filter(
        (place) =>
          place.path !== null &&
          (place.repo === null || place.repo === name) &&
          pathBelongsToModule(place.path, folder ? [folder] : []),
      ).length;

      if (!best || count > best.count) {
        best = {
          scope: folder ? `${repo.fullName}/${folder}` : repo.fullName,
          count,
        };
      }
    }
  }

  return best?.scope;
}

/** The entry a refused write says the page already holds, if it says one. */
function nearMatchOf(error: HttpException): string | null {
  const response = error.getResponse();
  const matches =
    response && typeof response === 'object'
      ? (response as { nearMatches?: Array<{ entryId?: string | null }> })
          .nearMatches
      : undefined;

  return matches?.find((match) => match.entryId)?.entryId ?? null;
}

function objectsIn(value: Prisma.JsonValue): Prisma.JsonObject[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Prisma.JsonObject =>
          item !== null && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
}

function objectOf(value: Prisma.JsonValue | undefined): Prisma.JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function stringField(value: Prisma.JsonValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
