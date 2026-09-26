import { Injectable } from '@nestjs/common';
import {
  inspectPath,
  LOCAL_REPO_SLUG,
  type LocalRepository,
  readRepositories,
} from 'integrations/local-repo/repositories';
import { PrismaService } from 'nestjs-prisma';
import { PluginContextFactory } from 'plugins/plugin-context.factory';

import { convertTiptapJsonToMarkdown } from 'common/utils/tiptap.utils';

import { ensureIntegrationBot } from 'modules/integration-events/integration-bot';
import { LoggerService } from 'modules/logger/logger.service';

import { type Lookups, type Outcome, planCreate, planUpdate } from './apply';
import { GitRepository } from './git';
import { type InboxReading } from './inbox';
import { type Snapshot, type SnapshotIssue } from './snapshot';
import { type HandOffSource, type PassResult, syncRepository } from './sync';

/**
 * The issue mirror for local repositories.
 *
 * An agent that works in a checkout on this machine, or in a clone of one,
 * often cannot reach Vantik: a sandbox with no network, a harness with no MCP,
 * a session nobody gave a token. It can always reach the repository. So each
 * repository that an admin opts in carries its teams' issues under
 * `refs/vantik/issues`, and takes proposals back under `refs/vantik/inbox/*`.
 * `sync.ts` holds the git side of that; this is the Vantik side.
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
  checklistItems?: Array<{ body: string; completed: boolean }>;
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
  ) {}

  /** Every opted-in local repository of every workspace, one at a time. */
  async runPass(): Promise<{
    repositories: number;
    wrote: number;
    handOffs: number;
  }> {
    const accounts = await this.prisma.integrationAccount.findMany({
      where: {
        deleted: null,
        integrationDefinition: { slug: LOCAL_REPO_SLUG },
      },
      select: { id: true, workspaceId: true, settings: true },
    });

    const totals = { repositories: 0, wrote: 0, handOffs: 0 };

    for (const account of accounts) {
      for (const repository of readRepositories(account.settings)) {
        if (!repository.gitIssues?.teamIds?.length) {
          continue;
        }

        totals.repositories++;

        try {
          const result = await this.syncLocalRepository(
            account.workspaceId,
            account.id,
            repository,
          );

          if (result?.wrote) {
            totals.wrote++;
          }
          totals.handOffs += result?.handOffs.length ?? 0;
        } catch (error) {
          this.logger.error({
            message: `Could not sync the issue mirror of ${repository.path}: ${error}`,
            where: 'GitIssuesService.runPass',
            error: error instanceof Error ? error : undefined,
          });
        }
      }
    }

    return totals;
  }

  async syncLocalRepository(
    workspaceId: string,
    accountId: string,
    repository: LocalRepository,
  ): Promise<PassResult | null> {
    // The fence is checked again on every pass: LOCAL_REPO_ROOT can have
    // narrowed since the path was added, and the path can have gone.
    const path = await inspectPath(repository.path);

    const teams = await this.prisma.team.findMany({
      where: {
        id: { in: repository.gitIssues?.teamIds ?? [] },
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
    const cacheKey = `${workspaceId}:${repository.id}:${teamIds.join(',')}`;
    // Taken before anything is read, so a change that lands during the pass
    // makes the next pass render again rather than being missed.
    const marker = await this.marker(workspaceId, teamIds);
    const lookups = await this.lookups(workspaceId, teams);

    const result = await syncRepository(
      new GitRepository(path),
      {
        load: () => this.loadSnapshot(workspaceId, lookups),
        apply: (reading, source) =>
          this.apply(workspaceId, accountId, lookups, reading, source),
      },
      {
        upToDate: async (tip) => {
          const last = this.fresh.get(cacheKey);
          return Boolean(last && last.tip === tip && last.marker === marker);
        },
        onInboxError: (name, error) =>
          this.logger.error({
            message: `Could not apply inbox ${name} in ${path}; it stays for the next pass: ${error}`,
            where: 'GitIssuesService.syncLocalRepository',
            error: error instanceof Error ? error : undefined,
          }),
      },
    );

    this.fresh.set(cacheKey, { tip: result.tip, marker });

    if (result.wrote || result.handOffs.length > 0) {
      this.logger.info({
        message: `Issue mirror of ${path}: ${result.handOffs.length} hand-off(s) read, snapshot ${result.wrote ? `now ${result.tip?.slice(0, 12)}` : 'unchanged'}`,
        where: 'GitIssuesService.syncLocalRepository',
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

    return JSON.stringify(results);
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
    const rows: IssueRow[] = await this.prisma.issue.findMany({
      where: {
        teamId: { in: lookups.teams.map((team) => team.id) },
        deleted: null,
      },
      orderBy: [{ teamId: 'asc' }, { number: 'asc' }],
      select: {
        ...ISSUE_SELECT,
        checklistItems: {
          where: { deleted: null },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          select: { body: true, completed: true },
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
    lookups: Lookups,
    reading: InboxReading,
    source: HandOffSource,
  ): Promise<Outcome[]> {
    if (reading.proposals.length === 0) {
      return [];
    }

    const definition = await this.prisma.integrationDefinitionV2.findFirst({
      where: { slug: LOCAL_REPO_SLUG, deleted: null },
    });
    const botId = await ensureIntegrationBot(this.prisma, workspaceId, {
      slug: LOCAL_REPO_SLUG,
      name: definition?.name ?? 'Local repository',
      icon: definition?.icon ?? LOCAL_REPO_SLUG,
    });
    const ctx = this.contextFactory.build(LOCAL_REPO_SLUG, workspaceId, botId);

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

        if (plan.input) {
          await ctx.issues.update(row.id, row.teamId, {
            ...plan.input,
            sourceMetadata,
          });
        }

        outcomes.push(plan.outcome);
        continue;
      }

      // A retried hand-off has the same commit, so the commit and the path
      // together say whether this file was already turned into a record.
      const origin = [
        { sourceMetadata: { path: ['gitCommit'], equals: source.commit.sha } },
        { sourceMetadata: { path: ['gitPath'], equals: proposal.path } },
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
          where: { issueId: issue.id, AND: origin },
          select: { id: true },
        });

        if (!existing) {
          await ctx.comments.create({
            issueId: issue.id,
            bodyMarkdown: proposal.body,
            sourceMetadata: { ...sourceMetadata, gitPath: proposal.path },
          });
        }

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

      const existing = await this.prisma.issue.findFirst({
        where: { teamId: plan.teamId, AND: origin },
        select: { number: true },
      });
      const team = lookups.teams.find(
        (candidate) => candidate.id === plan.teamId,
      );

      if (existing) {
        plan.outcome.applied.push(
          `${team?.identifier}-${existing.number} already created from this file`,
        );
      } else {
        const created = await ctx.issues.create(plan.teamId, {
          ...plan.input,
          sourceMetadata: { ...sourceMetadata, gitPath: proposal.path },
        });

        plan.outcome.applied.push(
          `created ${team?.identifier}-${created?.number}: ${JSON.stringify(plan.input.title)}`,
        );
      }

      outcomes.push(plan.outcome);
    }

    return outcomes;
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
