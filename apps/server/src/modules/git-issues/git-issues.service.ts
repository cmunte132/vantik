import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';
import { PluginContextFactory } from 'plugins/plugin-context.factory';

import { convertTiptapJsonToMarkdown } from 'common/utils/tiptap.utils';

import {
  newOutboxState,
  readOutbox,
  type OutboxBatch,
  RunOutboxService,
} from 'modules/agent-runs/run-outbox';
import { AgentSessionsService } from 'modules/agent-sessions/agent-sessions.service';
import { GitSourcesService } from 'modules/git/git-sources.service';
import { RepoMirrorService } from 'modules/git/repo-mirror.service';
import { ensureIntegrationBot } from 'modules/integration-events/integration-bot';
import { LoggerService } from 'modules/logger/logger.service';

import { type Lookups, type Outcome, planCreate, planUpdate } from './apply';
import { GitRepository } from './git';
import { type InboxReading, type OutboxProposal } from './inbox';
import { gitIssueRemote, HostRefusedPushError } from './issue-remote';
import {
  GIT_ISSUES_TARGETS,
  type MirroredRepository,
  type MirrorTargets,
} from './mirror-targets';
import {
  CLOSED_CATEGORIES,
  CLOSED_ISSUE_DAYS,
  type Snapshot,
  type SnapshotIssue,
} from './snapshot';
import { type HandOffSource, type PassResult, syncRepository } from './sync';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where a fact from git applies when it names no page. */
const REPOSITORY_SCOPE = 'repository';

/**
 * The issue mirror for repositories.
 *
 * An agent that works in a checkout on this machine, or in a clone of one,
 * often cannot reach Vantik: a sandbox with no network, a harness with no MCP,
 * a session nobody gave a token. It can always reach the repository. So each
 * repository that an admin opts in carries its teams' issues under
 * `refs/vantik/issues`, and takes proposals back under `refs/vantik/inbox/*`.
 * `sync.ts` holds the git side of that; this is the Vantik side.
 *
 * The server never writes into the checkout of a person. It works in its own
 * bare mirror of the repository (`RepoMirrorService`), fetches the issue refs
 * from the source, and pushes the snapshot back with a compare-and-set.
 *
 * Writes go through the plugin context as the local-repo integration's bot,
 * the way every other integration writes, so history, notifications and the
 * sync engine see them, and a person reading the issue sees who proposed the
 * change and that it came from git.
 */

interface IssueRow {
  id: string;
  number: number;
  title: string;
  description: string | null;
  priority: number | null;
  stateId: string;
  assigneeId: string | null;
  labelIds: string[];
  parentId: string | null;
  teamId: string;
  createdAt: Date;
  checklistItems?: Array<{ id: string; body: string; completed: boolean }>;
  comments?: Array<{
    id: string;
    body: string;
    userId: string | null;
    parentId: string | null;
    createdAt: Date;
    sourceMetadata: unknown;
  }>;
}

const ISSUE_SELECT = {
  id: true,
  number: true,
  title: true,
  description: true,
  priority: true,
  stateId: true,
  assigneeId: true,
  labelIds: true,
  parentId: true,
  teamId: true,
  createdAt: true,
} as const;

@Injectable()
export class GitIssuesService {
  private readonly logger = new LoggerService('GitIssuesService');

  /**
   * The tip each repository was last left at, and the state of the database
   * it was rendered from. While both still hold, a pass skips the render. In
   * memory only: after a restart the first pass renders once, finds the bytes
   * unchanged, and writes nothing.
   */
  private readonly fresh = new Map<
    string,
    { tip: string | null; marker: string }
  >();

  constructor(
    private prisma: PrismaService,
    private contextFactory: PluginContextFactory,
    private sources: GitSourcesService,
    private mirrors: RepoMirrorService,
    private sessions: AgentSessionsService,
    private outbox: RunOutboxService,
    @Inject(GIT_ISSUES_TARGETS) private targets: MirrorTargets[],
  ) {}

  /** Every opted-in repository of every workspace, one at a time. */
  async runPass(): Promise<{
    repositories: number;
    wrote: number;
    handOffs: number;
  }> {
    const totals = { repositories: 0, wrote: 0, handOffs: 0 };

    for (const tier of this.targets) {
      let repositories: MirroredRepository[];

      try {
        repositories = await tier.list();
      } catch (error) {
        this.logger.error({
          message: `Could not list the repositories of an issue mirror tier: ${error}`,
          where: 'GitIssuesService.runPass',
          error: error instanceof Error ? error : undefined,
        });
        continue;
      }

      for (const repository of repositories) {
        totals.repositories++;

        try {
          const result = await this.syncRepository(repository);

          if (result?.wrote) {
            totals.wrote++;
          }
          totals.handOffs += result?.handOffs.length ?? 0;
        } catch (error) {
          // A refusal by the host is one clear line for each pass. The pass
          // does not retry, and the other repositories go on.
          this.logger.error({
            message:
              error instanceof HostRefusedPushError
                ? `Issue mirror of ${repository.label}: ${error.message}`
                : `Could not sync the issue mirror of ${repository.label}: ${error}`,
            where: 'GitIssuesService.runPass',
            error: error instanceof Error ? error : undefined,
          });
        }
      }
    }

    return totals;
  }

  async syncRepository(target: MirroredRepository): Promise<PassResult | null> {
    const { workspaceId, integrationAccountId } = target;

    // The source checks every time that the account is in the workspace, that
    // it is not deleted and that it still lists the repository. A local path
    // is checked against the fence again too.
    const resolved = await this.sources.resolve({
      workspaceId,
      integrationAccountId,
      externalRepoId: target.externalRepoId,
    });

    if ('unresolved' in resolved) {
      throw new Error(resolved.unresolved);
    }

    const teams = await this.prisma.team.findMany({
      where: {
        id: { in: target.teamIds },
        workspaceId,
        deleted: null,
      },
      orderBy: { identifier: 'asc' },
    });

    if (teams.length === 0) {
      return null;
    }

    // A key is the identifier and the number, and identifiers are unique per
    // team name rather than per workspace. Two ENG teams in one mirror would
    // write each other's files.
    const identifiers = teams.map((team) => team.identifier);
    const repeated = identifiers.filter(
      (identifier, index) => identifiers.indexOf(identifier) !== index,
    );

    if (repeated.length > 0) {
      throw new Error(
        `more than one mirrored team uses the identifier ${[...new Set(repeated)].join(', ')}. Keep one of them in this repository's mirror`,
      );
    }

    const teamIds = teams.map((team) => team.id);
    const cacheKey = `${workspaceId}:${integrationAccountId}:${target.externalRepoId}:${teamIds.join(',')}`;
    // Taken before anything is read, so a change that lands during the pass
    // makes the next pass render again rather than being missed.
    const marker = await this.marker(workspaceId, teamIds);
    const lookups = await this.lookups(workspaceId, teams);

    const mirrorPath = this.mirrors.pathOf(resolved);
    const fetchRemote = await resolved.source.fetchRemote(resolved.repo);
    const pushRemote = await resolved.source.pushRemote(resolved.repo);

    let result: PassResult;

    try {
      result = await syncRepository(
        new GitRepository(mirrorPath),
        gitIssueRemote(
          mirrorPath,
          { fetch: fetchRemote, push: pushRemote },
          (work) => this.mirrors.exclusive(resolved, () => work()),
        ),
        {
          load: () => this.loadSnapshot(workspaceId, lookups),
          apply: (reading, source) =>
            this.apply(
              workspaceId,
              integrationAccountId,
              resolved.source.slug,
              lookups,
              reading,
              source,
            ),
        },
        {
          upToDate: async (tip) => {
            const last = this.fresh.get(cacheKey);
            return Boolean(last && last.tip === tip && last.marker === marker);
          },
          onInboxError: (name, error) =>
            this.logger.error({
              message: `Could not finish inbox ${name} in ${target.label}; it stays for the next pass: ${error}`,
              where: 'GitIssuesService.syncRepository',
              error: error instanceof Error ? error : undefined,
            }),
        },
      );
    } finally {
      await Promise.all([fetchRemote.dispose(), pushRemote.dispose()]);
    }

    this.fresh.set(cacheKey, { tip: result.tip, marker });

    if (result.wrote || result.handOffs.length > 0) {
      this.logger.info({
        message: `Issue mirror of ${target.label}: ${result.handOffs.length} hand-off(s) read, snapshot ${result.wrote ? `now ${result.tip?.slice(0, 12)}` : 'unchanged'}`,
        where: 'GitIssuesService.syncRepository',
      });
    }

    return result;
  }

  /**
   * A cheap summary of everything the render reads. Soft deletes move
   * `updatedAt` too, so a deleted comment changes it as well.
   */
  private async marker(
    workspaceId: string,
    teamIds: string[],
  ): Promise<string> {
    const inTeams = { teamId: { in: teamIds } };

    const results = await Promise.all([
      this.prisma.issue.aggregate({
        where: inTeams,
        _max: { updatedAt: true },
        _count: true,
      }),
      this.prisma.issueComment.aggregate({
        where: { issue: inTeams },
        _max: { updatedAt: true },
        _count: true,
      }),
      this.prisma.checklistItem.aggregate({
        where: { issue: inTeams },
        _max: { updatedAt: true },
        _count: true,
      }),
      this.prisma.workflow.aggregate({
        where: inTeams,
        _max: { updatedAt: true },
        _count: true,
      }),
      this.prisma.label.aggregate({
        where: { workspaceId },
        _max: { updatedAt: true },
        _count: true,
      }),
      this.prisma.team.aggregate({
        where: { id: { in: teamIds } },
        _max: { updatedAt: true },
        _count: true,
      }),
      this.prisma.user.aggregate({
        where: { usersOnWorkspaces: { some: { workspaceId } } },
        _max: { updatedAt: true },
        _count: true,
      }),
    ]);

    // The day is in the marker because a closed issue leaves the snapshot when
    // it gets old, and nothing in the database changes at that moment.
    return JSON.stringify([Math.floor(Date.now() / DAY_MS), ...results]);
  }

  private async lookups(
    workspaceId: string,
    teams: Array<{ id: string; identifier: string; name: string }>,
  ): Promise<Lookups> {
    const teamIds = teams.map((team) => team.id);
    const [workflows, labels] = await Promise.all([
      this.prisma.workflow.findMany({
        where: { teamId: { in: teamIds }, deleted: null },
        orderBy: { position: 'asc' },
      }),
      this.prisma.label.findMany({
        where: {
          workspaceId,
          deleted: null,
          OR: [{ teamId: null }, { teamId: { in: teamIds } }],
        },
        orderBy: { name: 'asc' },
      }),
    ]);

    return {
      teams: teams.map((team) => ({
        id: team.id,
        identifier: team.identifier,
        name: team.name,
        states: workflows
          .filter((workflow) => workflow.teamId === team.id)
          .map((workflow) => ({
            id: workflow.id,
            name: workflow.name,
            category: workflow.category,
            position: workflow.position,
          })),
      })),
      labels: labels.map((label) => ({ id: label.id, name: label.name })),
    };
  }

  private async loadSnapshot(
    workspaceId: string,
    lookups: Lookups,
  ): Promise<Snapshot> {
    const closedStateIds = lookups.teams.flatMap((team) =>
      team.states
        .filter((state) => CLOSED_CATEGORIES.includes(state.category))
        .map((state) => state.id),
    );
    const cutoff = new Date(Date.now() - CLOSED_ISSUE_DAYS * DAY_MS);

    const rows: IssueRow[] = await this.prisma.issue.findMany({
      where: {
        teamId: { in: lookups.teams.map((team) => team.id) },
        deleted: null,
        // An open issue is always here. A closed one stays for a while, so
        // that an agent can still read how it ended.
        ...(closedStateIds.length > 0
          ? {
              OR: [
                { stateId: { notIn: closedStateIds } },
                { stateEnteredAt: { gte: cutoff } },
              ],
            }
          : {}),
      },
      orderBy: [{ teamId: 'asc' }, { number: 'asc' }],
      select: {
        ...ISSUE_SELECT,
        checklistItems: {
          where: { deleted: null },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          select: { id: true, body: true, completed: true },
        },
        comments: {
          where: { deleted: null },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            body: true,
            userId: true,
            parentId: true,
            createdAt: true,
            sourceMetadata: true,
          },
        },
      },
    });

    return {
      teams: lookups.teams.map((team) => ({
        identifier: team.identifier,
        name: team.name,
        states: team.states.map((state) => ({
          name: state.name,
          category: state.category,
        })),
      })),
      labels: lookups.labels.map((label) => label.name),
      issues: await this.toSnapshotIssues(workspaceId, rows, lookups),
    };
  }

  /** Rows as the mirror names them: keys, state names, usernames. */
  private async toSnapshotIssues(
    workspaceId: string,
    rows: IssueRow[],
    lookups: Lookups,
  ): Promise<SnapshotIssue[]> {
    const userIds = new Set<string>();
    const parentIds = new Set<string>();

    for (const row of rows) {
      if (row.assigneeId) {
        userIds.add(row.assigneeId);
      }
      if (row.parentId) {
        parentIds.add(row.parentId);
      }
      for (const comment of row.comments ?? []) {
        if (comment.userId) {
          userIds.add(comment.userId);
        }
      }
    }

    const teamsById = new Map(lookups.teams.map((team) => [team.id, team]));
    const keys = new Map(
      rows.map((row) => [
        row.id,
        `${teamsById.get(row.teamId)?.identifier}-${row.number}`,
      ]),
    );
    const missingParents = [...parentIds].filter((id) => !keys.has(id));

    const [users, parents] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: [...userIds] } },
        select: { id: true, username: true },
      }),
      missingParents.length > 0
        ? this.prisma.issue.findMany({
            where: { id: { in: missingParents }, team: { workspaceId } },
            select: {
              id: true,
              number: true,
              team: { select: { identifier: true } },
            },
          })
        : Promise.resolve([]),
    ]);

    for (const parent of parents) {
      keys.set(parent.id, `${parent.team.identifier}-${parent.number}`);
    }

    const usernames = new Map(users.map((user) => [user.id, user.username]));
    const labelNames = new Map(
      lookups.labels.map((label) => [label.id, label.name]),
    );
    const states = new Map(
      lookups.teams.flatMap((team) =>
        team.states.map((state) => [state.id, state]),
      ),
    );

    return rows.map((row) => {
      const state = states.get(row.stateId);

      return {
        id: row.id,
        key: keys.get(row.id) as string,
        number: row.number,
        team: teamsById.get(row.teamId)?.identifier ?? '',
        title: row.title,
        state: state?.name ?? 'Unknown',
        stateCategory: state?.category ?? 'BACKLOG',
        priority: row.priority,
        assignee: row.assigneeId
          ? (usernames.get(row.assigneeId) ?? null)
          : null,
        labels: row.labelIds
          .map((id) => labelNames.get(id))
          .filter((name): name is string => Boolean(name)),
        parent: row.parentId ? (keys.get(row.parentId) ?? null) : null,
        createdAt: row.createdAt,
        description: convertTiptapJsonToMarkdown(row.description ?? ''),
        checklist: row.checklistItems ?? [],
        comments: (row.comments ?? []).map((comment) => ({
          id: comment.id,
          author: commentAuthor(comment, usernames),
          createdAt: comment.createdAt,
          replyTo: comment.parentId,
          body: convertTiptapJsonToMarkdown(comment.body),
        })),
      };
    });
  }

  private async apply(
    workspaceId: string,
    accountId: string,
    slug: string,
    lookups: Lookups,
    reading: InboxReading,
    source: HandOffSource,
  ): Promise<Outcome[]> {
    if (reading.proposals.length === 0) {
      return [];
    }

    const definition = await this.prisma.integrationDefinitionV2.findFirst({
      where: { slug, deleted: null },
    });
    const botId = await ensureIntegrationBot(this.prisma, workspaceId, {
      slug,
      name: definition?.name ?? 'Repository',
      icon: definition?.icon ?? slug,
    });
    const ctx = this.contextFactory.build(slug, workspaceId, botId);

    // The commit author is whatever the agent's git config said. It is shown
    // as who proposed the change, never matched to a Vantik user.
    const sourceMetadata = {
      id: accountId,
      type: 'git',
      userDisplayName:
        source.commit.authorName || source.commit.authorEmail || 'unknown',
      gitInbox: source.name,
      gitCommit: source.commit.sha,
    };

    const teamIds = lookups.teams.map((team) => team.id);
    const outcomes: Outcome[] = [];
    /** The issues that this hand-off changed or wrote to. */
    const touched = new Set<string>();

    for (const proposal of reading.proposals) {
      if (proposal.kind === 'update') {
        const row = await this.prisma.issue.findFirst({
          where: {
            id: proposal.issueId,
            teamId: { in: teamIds },
            deleted: null,
          },
          select: ISSUE_SELECT,
        });

        if (!row) {
          outcomes.push({
            path: proposal.path,
            applied: [],
            refused: [`${proposal.key} is no longer in this mirror`],
          });
          continue;
        }

        const [current] = await this.toSnapshotIssues(
          workspaceId,
          [row],
          lookups,
        );
        const plan = planUpdate(current, proposal, lookups);

        // `close_task` posts the resolution as a note before the state
        // changes, so a later search finds the note as the resolution.
        if (plan.resolution && plan.input?.stateId) {
          await this.postNote(
            ctx,
            row.id,
            plan.resolution,
            `${proposal.path}#resolution`,
            sourceMetadata,
          );
        }

        if (plan.input) {
          await ctx.issues.update(row.id, row.teamId, {
            ...plan.input,
            sourceMetadata,
          });
        }

        touched.add(row.id);
        outcomes.push(plan.outcome);
        continue;
      }

      if (proposal.kind === 'outbox') {
        outcomes.push(
          await this.applyOutbox({
            workspaceId,
            accountId,
            botId,
            proposal,
            lookups,
            sourceMetadata,
            source,
            touched,
          }),
        );
        continue;
      }

      // A hand-off that is read again has the same files with the same
      // content, so the path and a hash of the content say whether a file was
      // already turned into a record. The commit is no part of the test: the
      // follow-up commit of an agent can carry a file that an earlier commit
      // already carried.
      const origin = (content: string) => [
        { sourceMetadata: { path: ['gitPath'], equals: proposal.path } },
        {
          sourceMetadata: {
            path: ['gitContentHash'],
            equals: contentHash(content),
          },
        },
      ];

      if (proposal.kind === 'comment') {
        const issue = await this.issueByKey(proposal.key, lookups);

        if (!issue) {
          outcomes.push({
            path: proposal.path,
            applied: [],
            refused: [`${proposal.key} is not an issue in this mirror`],
          });
          continue;
        }

        const existing = await this.prisma.issueComment.findFirst({
          where: { issueId: issue.id, AND: origin(proposal.body) },
          select: { id: true },
        });

        if (!existing) {
          await ctx.comments.create({
            issueId: issue.id,
            bodyMarkdown: proposal.body,
            sourceMetadata: {
              ...sourceMetadata,
              gitPath: proposal.path,
              gitContentHash: contentHash(proposal.body),
            },
          });
        }

        touched.add(issue.id);
        outcomes.push({
          path: proposal.path,
          applied: [
            `${proposal.key} comment ${existing ? 'already added' : 'added'}`,
          ],
          refused: [],
        });
        continue;
      }

      const plan = planCreate(proposal, lookups);

      if (!plan.input || !plan.teamId) {
        outcomes.push(plan.outcome);
        continue;
      }

      const createdFrom = JSON.stringify(plan.input);
      const existing = await this.prisma.issue.findFirst({
        where: { teamId: plan.teamId, AND: origin(createdFrom) },
        select: { id: true, number: true },
      });
      const team = lookups.teams.find(
        (candidate) => candidate.id === plan.teamId,
      );

      if (existing) {
        touched.add(existing.id);
        plan.outcome.applied.push(
          `${team?.identifier}-${existing.number} already created from this file`,
        );
      } else {
        const created = await ctx.issues.create(plan.teamId, {
          ...plan.input,
          sourceMetadata: {
            ...sourceMetadata,
            gitPath: proposal.path,
            gitContentHash: contentHash(createdFrom),
          },
        });

        if (created?.id) {
          touched.add(created.id);
        }

        plan.outcome.applied.push(
          `created ${team?.identifier}-${created?.number}: ${JSON.stringify(plan.input.title)}`,
        );
      }

      outcomes.push(plan.outcome);
    }

    await this.recordSession(workspaceId, botId, source, touched);

    return outcomes;
  }

  /**
   * Links the session that a hand-off names to each issue that the hand-off
   * touched. A commit without a `Vantik-Session` trailer makes no session. A
   * fault here never fails the hand-off: the session is a record about the
   * work, and the work is done.
   */
  private async recordSession(
    workspaceId: string,
    actorUserId: string,
    source: HandOffSource,
    issueIds: Set<string>,
  ) {
    if (!source.session) {
      return;
    }

    for (const issueId of issueIds) {
      try {
        await this.sessions.recordInboxSession(
          { workspaceId, userId: actorUserId },
          {
            issueId,
            externalId: source.session.id,
            harness: source.session.harness,
          },
        );
      } catch (error) {
        this.logger.warn({
          message: `Could not record session ${source.session.id} on an issue from inbox ${source.name}: ${error}`,
          where: 'GitIssuesService.recordSession',
        });
      }
    }
  }

  /**
   * Posts a note unless an earlier pass posted it. A file and a hash of its
   * content say whether a note came from it already, in the same way as for a
   * comment file.
   */
  private async postNote(
    ctx: ReturnType<PluginContextFactory['build']>,
    issueId: string,
    body: string,
    gitPath: string,
    sourceMetadata: Record<string, unknown>,
  ): Promise<boolean> {
    if (await this.noteExists(issueId, gitPath, body)) {
      return false;
    }

    await ctx.comments.create({
      issueId,
      bodyMarkdown: body,
      sourceMetadata: {
        ...sourceMetadata,
        gitPath,
        gitContentHash: contentHash(body),
      },
    });

    return true;
  }

  /** Whether an earlier pass posted this text as a note from this file. */
  private async noteExists(
    issueId: string,
    gitPath: string,
    body: string,
  ): Promise<boolean> {
    const existing = await this.prisma.issueComment.findFirst({
      where: {
        issueId,
        AND: [
          { sourceMetadata: { path: ['gitPath'], equals: gitPath } },
          {
            sourceMetadata: {
              path: ['gitContentHash'],
              equals: contentHash(body),
            },
          },
        ],
      },
      select: { id: true },
    });

    return Boolean(existing);
  }

  /**
   * The notes, the criteria ticks and the facts that an agent appended to the
   * outbox file of an issue.
   *
   * The checks and the writes are those of an agent run: `readOutbox` bounds
   * and validates each line, and `RunOutboxService` writes as the bot. A
   * criterion must be one of this issue. A question is refused, because a
   * question waits for an answer and git has no way to bring one back.
   * Each note and each fact is written once, so a hand-off that a pass reads
   * again adds nothing.
   */
  private async applyOutbox(input: {
    workspaceId: string;
    accountId: string;
    botId: string;
    proposal: OutboxProposal;
    lookups: Lookups;
    sourceMetadata: Record<string, unknown>;
    source: HandOffSource;
    touched: Set<string>;
  }): Promise<Outcome> {
    const { proposal, sourceMetadata, source } = input;
    const outcome: Outcome = { path: proposal.path, applied: [], refused: [] };
    const issue = await this.issueByKey(proposal.key, input.lookups);

    if (!issue) {
      outcome.refused.push(`${proposal.key} is not an issue in this mirror`);
      return outcome;
    }

    const criteria = await this.prisma.checklistItem.findMany({
      where: { issueId: issue.id, deleted: null },
      select: { id: true },
    });
    const state = newOutboxState();
    const batch = readOutbox(
      proposal.text,
      {
        definitionOfDone: criteria.map((criterion) => ({
          id: criterion.id,
          body: '',
          completed: false,
        })),
      },
      state,
    );

    for (const rejected of batch.rejected) {
      outcome.refused.push(
        `${proposal.key} outbox line ${rejected.line}: ${rejected.reason}`,
      );
    }

    if (batch.questions.length > 0 || batch.refusedQuestions.length > 0) {
      outcome.refused.push(
        `${proposal.key} outbox: Vantik does not read a question from git, because it cannot send the answer back. Ask in a note`,
      );
    }

    const bot = {
      issueId: issue.id,
      workspaceId: input.workspaceId,
      actorUserId: input.botId,
      requesterId: null as string | null,
    };
    const scrub = (text: string) => text;
    const empty: OutboxBatch = {
      notes: [],
      facts: [],
      criteria: [],
      questions: [],
      refusedQuestions: [],
      rejected: [],
    };
    const failures: string[] = [];
    let notes = 0;
    let repeated = 0;

    for (const note of batch.notes) {
      const gitPath = `${proposal.path}#note`;

      if (await this.noteExists(issue.id, gitPath, note.body)) {
        repeated += 1;
        continue;
      }

      const written = await this.outbox.apply(
        {
          ...bot,
          noteSource: {
            ...sourceMetadata,
            gitPath,
            gitContentHash: contentHash(note.body),
          },
        },
        { ...empty, notes: [note] },
        REPOSITORY_SCOPE,
        scrub,
      );

      notes += written.applied.length;
      failures.push(...written.failed);
    }

    const factSource = `git-inbox:${input.accountId}:${source.name}`;
    // An agent names each hand-off anew and builds on its own head, so a
    // follow-up can carry a fact that an earlier inbox already did. The
    // check spans every inbox of this account; the stored name stays.
    const factSources = `git-inbox:${input.accountId}:`;
    const facts: OutboxBatch['facts'] = [];

    for (const fact of batch.facts) {
      if (
        await this.prisma.pageEntry.findFirst({
          where: {
            sourceSession: { startsWith: factSources },
            content: fact.content,
            deleted: null,
          },
          select: { id: true },
        })
      ) {
        repeated += 1;
      } else {
        facts.push(fact);
      }
    }

    const proposed = facts.length
      ? await this.outbox.apply(
          { ...bot, factSource },
          { ...empty, facts },
          REPOSITORY_SCOPE,
          scrub,
        )
      : { applied: [], failed: [] as string[] };
    const ticked = batch.criteria.length
      ? await this.outbox.tickCriteria(bot, state)
      : { applied: [], failed: [] as string[] };

    failures.push(...proposed.failed, ...ticked.failed);

    const count = (n: number, one: string, many = `${one}s`) =>
      `${n} ${n === 1 ? one : many}`;

    if (notes) {
      outcome.applied.push(
        `${proposal.key} outbox: ${count(notes, 'note')} added`,
      );
    }
    if (proposed.applied.length) {
      outcome.applied.push(
        `${proposal.key} outbox: ${count(proposed.applied.length, 'fact')} proposed`,
      );
    }
    if (ticked.applied.length) {
      outcome.applied.push(
        `${proposal.key} outbox: ${count(ticked.applied.length, 'criterion', 'criteria')} ticked`,
      );
    }
    if (repeated) {
      outcome.applied.push(
        `${proposal.key} outbox: ${count(repeated, 'line')} already applied`,
      );
    }
    for (const failure of failures) {
      outcome.refused.push(
        `${proposal.key} outbox: could not apply ${failure}`,
      );
    }

    input.touched.add(issue.id);

    return outcome;
  }

  /**
   * `ENG-42` to the issue. The team part is matched among the mirrored teams
   * only, which is what makes it unambiguous: identifiers are unique per team
   * name, not per workspace.
   */
  private async issueByKey(key: string, lookups: Lookups) {
    const match = /^(.+)-(\d+)$/.exec(key);
    const team = match
      ? lookups.teams.find((candidate) => candidate.identifier === match[1])
      : undefined;

    if (!match || !team) {
      return null;
    }

    return await this.prisma.issue.findFirst({
      where: { teamId: team.id, number: Number(match[2]), deleted: null },
      select: { id: true },
    });
  }
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function commentAuthor(
  comment: { userId: string | null; sourceMetadata: unknown },
  usernames: Map<string, string>,
): string {
  const metadata = comment.sourceMetadata as {
    userDisplayName?: string;
    type?: string;
  } | null;

  // An integration's comments are written by its bot; the person behind them
  // is the display name it recorded.
  if (metadata?.userDisplayName) {
    return `${metadata.userDisplayName} via ${metadata.type ?? 'integration'}`;
  }

  return (comment.userId && usernames.get(comment.userId)) || 'unknown';
}
