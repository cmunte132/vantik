import { Injectable, NotFoundException } from '@nestjs/common';
import { IssueRelationType, WorkflowCategoryEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { convertTiptapJsonToMarkdown } from 'common/utils/tiptap.utils';

import {
  ContextComment,
  ContextHistoryEntry,
  ContextIssueRef,
  ContextLabel,
  ContextLinkedIssue,
  ContextRelation,
  ContextUser,
  IssueContext,
  inverseRelationType,
  priorityNames,
} from './issue-context.interface';

interface IssueRefRow {
  id: string;
  number: number;
  title: string;
  stateId: string;
  team: { identifier: string };
}

interface HistoryLookups {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stateById: Map<string, any>;
  labelById: Map<string, { id: string; name: string }>;
  userById: Map<string, { id: string; fullname: string }>;
  teamById: Map<string, { id: string; name: string }>;
  projectById: Map<string, { id: string; name: string }>;
  cycleById: Map<string, { id: string; name: string }>;
  issueById: Map<string, IssueRefRow>;
}

/**
 * Assembles the full working context of a single issue — description, comments,
 * history, relations — with every id resolved to a human readable name, so an
 * agent can start working from one request.
 */
@Injectable()
export default class IssueContextService {
  constructor(private prisma: PrismaService) {}

  async getIssueContext(issueId: string): Promise<IssueContext> {
    const issue = await this.prisma.issue.findFirst({
      where: { id: issueId, deleted: null },
      include: {
        team: true,
        project: { select: { id: true, name: true } },
        cycle: { select: { id: true, name: true } },
        parent: { include: { team: { select: { identifier: true } } } },
        subIssue: {
          where: { deleted: null },
          include: { team: { select: { identifier: true } } },
          orderBy: { number: 'asc' },
        },
        comments: {
          where: { deleted: null },
          orderBy: { createdAt: 'asc' },
        },
        history: { where: { deleted: null }, orderBy: { createdAt: 'asc' } },
        linkedIssue: { where: { deleted: null } },
        issueRelations: { where: { deleted: null } },
      },
    });

    if (!issue) {
      throw new NotFoundException(`Issue ${issueId} not found`);
    }

    // Relations are stored one-directional, so the ones pointing *at* this
    // issue live on other issues' rows and need a second query.
    const incomingRelations = await this.prisma.issueRelation.findMany({
      where: { relatedIssueId: issueId, deleted: null },
    });

    const relatedIssueIds = [
      ...new Set([
        ...issue.issueRelations.map((relation) => relation.relatedIssueId),
        ...incomingRelations.map((relation) => relation.issueId),
      ]),
    ];

    const relatedIssues = await this.getIssueRefRows(relatedIssueIds);

    const stateIds = [
      issue.stateId,
      ...issue.subIssue.map((subIssue) => subIssue.stateId),
      ...issue.history.flatMap(({ fromStateId, toStateId }) => [
        fromStateId,
        toStateId,
      ]),
    ];
    const labelIds = [
      ...issue.labelIds,
      ...issue.history.flatMap(({ addedLabelIds, removedLabelIds }) => [
        ...addedLabelIds,
        ...removedLabelIds,
      ]),
    ];
    const userIds = [
      issue.assigneeId,
      ...issue.comments.map((comment) => comment.userId),
      ...issue.history.flatMap(({ userId, fromAssigneeId, toAssigneeId }) => [
        userId,
        fromAssigneeId,
        toAssigneeId,
      ]),
    ];
    const teamIds = issue.history.flatMap(({ fromTeamId, toTeamId }) => [
      fromTeamId,
      toTeamId,
    ]);
    const projectIds = issue.history.flatMap(
      ({ fromProjectId, toProjectId }) => [fromProjectId, toProjectId],
    );
    const cycleIds = issue.history.flatMap(({ fromCycleId, toCycleId }) => [
      fromCycleId,
      toCycleId,
    ]);
    const parentIds = issue.history.flatMap(({ fromParentId, toParentId }) => [
      fromParentId,
      toParentId,
    ]);

    const [states, labels, users, teams, projects, cycles, historyIssues] =
      await Promise.all([
        this.prisma.workflow.findMany({
          where: { id: { in: unique(stateIds) } },
          select: { id: true, name: true, category: true },
        }),
        this.prisma.label.findMany({
          where: { id: { in: unique(labelIds) } },
          select: { id: true, name: true },
        }),
        this.prisma.user.findMany({
          where: { id: { in: unique(userIds) } },
          select: { id: true, fullname: true },
        }),
        this.prisma.team.findMany({
          where: { id: { in: unique(teamIds) } },
          select: { id: true, name: true },
        }),
        this.prisma.project.findMany({
          where: { id: { in: unique(projectIds) } },
          select: { id: true, name: true },
        }),
        this.prisma.cycle.findMany({
          where: { id: { in: unique(cycleIds) } },
          select: { id: true, name: true },
        }),
        this.getIssueRefRows(unique(parentIds)),
      ]);

    const stateById = byId(states);
    const labelById = byId(labels);
    const userById = byId(users);
    const teamById = byId(teams);
    const projectById = byId(projects);
    const cycleById = byId(cycles);
    const relatedIssueById = byId(relatedIssues);
    const historyIssueById = byId(historyIssues);

    const state = stateById.get(issue.stateId);

    const relations: ContextRelation[] = [
      ...issue.issueRelations.map((relation) => ({
        type: relation.type as IssueRelationType,
        issue: relatedIssueById.get(relation.relatedIssueId),
      })),
      ...incomingRelations.map((relation) => ({
        type: inverseRelationType[relation.type] ?? relation.type,
        issue: relatedIssueById.get(relation.issueId),
      })),
    ]
      .filter((relation) => relation.issue)
      .map((relation) => ({
        type: relation.type,
        issue: this.toIssueRef(relation.issue, stateById),
      }));

    return {
      id: issue.id,
      key: `${issue.team.identifier}-${issue.number}`,
      title: issue.title,
      descriptionMarkdown: convertTiptapJsonToMarkdown(issue.description),
      state: state
        ? {
            id: state.id,
            name: state.name,
            category: state.category as WorkflowCategoryEnum,
          }
        : null,
      assignee: this.toUser(issue.assigneeId, userById),
      team: {
        id: issue.team.id,
        identifier: issue.team.identifier,
        name: issue.team.name,
      },
      labels: issue.labelIds
        .map((labelId) => labelById.get(labelId))
        .filter(Boolean) as ContextLabel[],
      priority: issue.priority,
      estimate: issue.estimate,
      dueDate: issue.dueDate,
      project: issue.project ?? null,
      cycle: issue.cycle ?? null,
      parent: issue.parent
        ? this.toIssueRef(issue.parent as IssueRefRow, stateById)
        : null,
      subIssues: issue.subIssue.map((subIssue) =>
        this.toIssueRef(subIssue as IssueRefRow, stateById),
      ),
      relations,
      linkedIssues: issue.linkedIssue.map((linkedIssue) =>
        this.toLinkedIssue(linkedIssue),
      ),
      comments: this.nestComments(issue.comments, userById),
      history: this.condenseHistory(issue.history, {
        stateById,
        labelById,
        userById,
        teamById,
        projectById,
        cycleById,
        issueById: historyIssueById,
      }),
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    };
  }

  /**
   * Top-level comments in chronological order, each with its replies nested one
   * level deep — the same shape the context endpoint returns.
   */
  async getIssueComments(issueId: string): Promise<ContextComment[]> {
    const issue = await this.prisma.issue.findFirst({
      where: { id: issueId, deleted: null },
      select: { id: true },
    });

    if (!issue) {
      throw new NotFoundException(`Issue ${issueId} not found`);
    }

    const comments = await this.prisma.issueComment.findMany({
      where: { issueId, deleted: null },
      orderBy: { createdAt: 'asc' },
    });

    const users = await this.prisma.user.findMany({
      where: { id: { in: unique(comments.map((comment) => comment.userId)) } },
      select: { id: true, fullname: true },
    });

    return this.nestComments(comments, byId(users));
  }

  async getIssueHistory(issueId: string): Promise<ContextHistoryEntry[]> {
    const issue = await this.prisma.issue.findFirst({
      where: { id: issueId, deleted: null },
      select: { id: true },
    });

    if (!issue) {
      throw new NotFoundException(`Issue ${issueId} not found`);
    }

    const historyRows = await this.prisma.issueHistory.findMany({
      where: { issueId, deleted: null },
      orderBy: { createdAt: 'asc' },
    });

    return this.condenseHistory(
      historyRows,
      await this.historyLookups(historyRows),
    );
  }

  /**
   * Batched name lookups for every id referenced by a set of history rows.
   */
  private async historyLookups(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    historyRows: any[],
  ): Promise<HistoryLookups> {
    const [states, labels, users, teams, projects, cycles, issues] =
      await Promise.all([
        this.prisma.workflow.findMany({
          where: {
            id: {
              in: unique(
                historyRows.flatMap(({ fromStateId, toStateId }) => [
                  fromStateId,
                  toStateId,
                ]),
              ),
            },
          },
          select: { id: true, name: true, category: true },
        }),
        this.prisma.label.findMany({
          where: {
            id: {
              in: unique(
                historyRows.flatMap(({ addedLabelIds, removedLabelIds }) => [
                  ...addedLabelIds,
                  ...removedLabelIds,
                ]),
              ),
            },
          },
          select: { id: true, name: true },
        }),
        this.prisma.user.findMany({
          where: {
            id: {
              in: unique(
                historyRows.flatMap(
                  ({ userId, fromAssigneeId, toAssigneeId }) => [
                    userId,
                    fromAssigneeId,
                    toAssigneeId,
                  ],
                ),
              ),
            },
          },
          select: { id: true, fullname: true },
        }),
        this.prisma.team.findMany({
          where: {
            id: {
              in: unique(
                historyRows.flatMap(({ fromTeamId, toTeamId }) => [
                  fromTeamId,
                  toTeamId,
                ]),
              ),
            },
          },
          select: { id: true, name: true },
        }),
        this.prisma.project.findMany({
          where: {
            id: {
              in: unique(
                historyRows.flatMap(({ fromProjectId, toProjectId }) => [
                  fromProjectId,
                  toProjectId,
                ]),
              ),
            },
          },
          select: { id: true, name: true },
        }),
        this.prisma.cycle.findMany({
          where: {
            id: {
              in: unique(
                historyRows.flatMap(({ fromCycleId, toCycleId }) => [
                  fromCycleId,
                  toCycleId,
                ]),
              ),
            },
          },
          select: { id: true, name: true },
        }),
        this.getIssueRefRows(
          unique(
            historyRows.flatMap(({ fromParentId, toParentId }) => [
              fromParentId,
              toParentId,
            ]),
          ),
        ),
      ]);

    return {
      stateById: byId(states),
      labelById: byId(labels),
      userById: byId(users),
      teamById: byId(teams),
      projectById: byId(projects),
      cycleById: byId(cycles),
      issueById: byId(issues),
    };
  }

  private async getIssueRefRows(issueIds: string[]): Promise<IssueRefRow[]> {
    if (issueIds.length === 0) {
      return [];
    }

    return this.prisma.issue.findMany({
      where: { id: { in: issueIds }, deleted: null },
      select: {
        id: true,
        number: true,
        title: true,
        stateId: true,
        team: { select: { identifier: true } },
      },
    });
  }

  private toIssueRef(
    issue: IssueRefRow,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stateById: Map<string, any>,
  ): ContextIssueRef {
    return {
      id: issue.id,
      key: `${issue.team.identifier}-${issue.number}`,
      title: issue.title,
      stateCategory: stateById.get(issue.stateId)?.category ?? null,
    };
  }

  private toUser(
    userId: string | null,
    userById: Map<string, { id: string; fullname: string }>,
  ): ContextUser | null {
    if (!userId) {
      return null;
    }
    const user = userById.get(userId);
    return user ? { id: user.id, fullname: user.fullname } : null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toLinkedIssue(linkedIssue: any): ContextLinkedIssue {
    const sourceData =
      typeof linkedIssue.sourceData === 'object' && linkedIssue.sourceData
        ? linkedIssue.sourceData
        : {};

    return {
      id: linkedIssue.id,
      url: linkedIssue.url,
      title: sourceData.title ?? null,
    };
  }

  private nestComments(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    comments: any[],
    userById: Map<string, { id: string; fullname: string }>,
  ): ContextComment[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toComment = (comment: any): ContextComment => ({
      id: comment.id,
      author: this.toUser(comment.userId, userById),
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      bodyMarkdown: convertTiptapJsonToMarkdown(comment.body),
    });

    const topLevel = comments.filter((comment) => !comment.parentId);
    const repliesByParent = new Map<string, ContextComment[]>();

    for (const comment of comments) {
      if (!comment.parentId) {
        continue;
      }
      const replies = repliesByParent.get(comment.parentId) ?? [];
      replies.push(toComment(comment));
      repliesByParent.set(comment.parentId, replies);
    }

    return topLevel.map((comment) => ({
      ...toComment(comment),
      replies: repliesByParent.get(comment.id) ?? [],
    }));
  }

  /**
   * Turns raw from/to history rows into readable entries. A single row can
   * carry several changes (state + assignee + labels), each of which becomes
   * its own entry; rows where nothing readable changed are dropped.
   */
  private condenseHistory(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    historyRows: any[],
    lookups: HistoryLookups,
  ): ContextHistoryEntry[] {
    const entries: ContextHistoryEntry[] = [];

    const named = <T>(
      map: Map<string, T>,
      id: string | null,
      pick: (value: T) => string,
    ): string | null => (id ? (map.get(id) ? pick(map.get(id)) : id) : null);

    for (const row of historyRows) {
      const at = row.createdAt;
      const actor = row.userId
        ? (lookups.userById.get(row.userId)?.fullname ?? null)
        : null;

      const push = (
        change: string,
        from: string | number | null,
        to: string | number | null,
      ) => {
        if (from === null && to === null) {
          return;
        }
        entries.push({ at, actor, change, from, to });
      };

      if (row.fromStateId || row.toStateId) {
        push(
          'state',
          named(lookups.stateById, row.fromStateId, (state) => state.name),
          named(lookups.stateById, row.toStateId, (state) => state.name),
        );
      }

      if (row.fromAssigneeId || row.toAssigneeId) {
        push(
          'assignee',
          named(lookups.userById, row.fromAssigneeId, (user) => user.fullname),
          named(lookups.userById, row.toAssigneeId, (user) => user.fullname),
        );
      }

      if (row.fromPriority !== null || row.toPriority !== null) {
        push(
          'priority',
          priorityLabel(row.fromPriority),
          priorityLabel(row.toPriority),
        );
      }

      if (row.fromEstimate !== null || row.toEstimate !== null) {
        push('estimate', row.fromEstimate ?? null, row.toEstimate ?? null);
      }

      if (row.fromTeamId || row.toTeamId) {
        push(
          'team',
          named(lookups.teamById, row.fromTeamId, (team) => team.name),
          named(lookups.teamById, row.toTeamId, (team) => team.name),
        );
      }

      if (row.fromProjectId || row.toProjectId) {
        push(
          'project',
          named(
            lookups.projectById,
            row.fromProjectId,
            (project) => project.name,
          ),
          named(
            lookups.projectById,
            row.toProjectId,
            (project) => project.name,
          ),
        );
      }

      if (row.fromCycleId || row.toCycleId) {
        push(
          'cycle',
          named(lookups.cycleById, row.fromCycleId, (cycle) => cycle.name),
          named(lookups.cycleById, row.toCycleId, (cycle) => cycle.name),
        );
      }

      if (row.fromParentId || row.toParentId) {
        const issueKey = (id: string | null) => {
          if (!id) {
            return null;
          }
          const parent = lookups.issueById.get(id);
          return parent ? `${parent.team.identifier}-${parent.number}` : id;
        };
        push('parent', issueKey(row.fromParentId), issueKey(row.toParentId));
      }

      for (const labelId of row.addedLabelIds ?? []) {
        push('label', null, lookups.labelById.get(labelId)?.name ?? labelId);
      }

      for (const labelId of row.removedLabelIds ?? []) {
        push('label', lookups.labelById.get(labelId)?.name ?? labelId, null);
      }
    }

    return entries;
  }
}

function priorityLabel(priority: number | null): string | null {
  if (priority === null || priority === undefined) {
    return null;
  }
  return priorityNames[priority] ?? String(priority);
}

function unique(ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter(Boolean))] as string[];
}

function byId<T extends { id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}
