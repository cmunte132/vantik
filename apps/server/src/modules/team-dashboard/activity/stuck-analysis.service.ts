import { createHash } from 'crypto';

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StuckIssue } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { convertTiptapJsonToMarkdown } from 'common/utils/tiptap.utils';

import { isLLMConfigured } from 'modules/ai-requests/llm-provider';
import { generateModelText } from 'modules/ai-requests/model-call';
import { priorityNames } from 'modules/issues/issue-context.interface';
import { LoggerService } from 'modules/logger/logger.service';

import { moveTime } from '../team-dashboard.compute';
import { TeamDashboardService } from '../team-dashboard.service';
import {
  buildStuckPrompt,
  parseStuckAnswer,
  STUCK_PURPOSE,
  STUCK_SYSTEM,
  StuckPromptInput,
} from './stuck-analysis.prompt';
import { analysisMaxIssues } from './team-activity.interface';

const DESCRIPTION_CHARS = 1500;
const COMMENT_CHARS = 500;
const COMMENT_COUNT = 5;
const HISTORY_COUNT = 10;
/** The run stops when the model fails this many times in a row. */
const MAX_CONSECUTIVE_FAILURES = 3;

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}...` : text;

interface Evidence {
  updatedAt: Date;
  latestCommentId: string | null;
  links: Array<{ url: string; sourceData: unknown }>;
}

/**
 * Asks the system LLM why each stuck issue of a team is stuck, and stores the
 * answer. It writes StuckIssueFinding rows and nothing else. In particular it
 * never writes an issue or a comment, because that would count as team
 * activity and the analysis would keep itself running.
 */
@Injectable()
export class StuckAnalysisService {
  private readonly logger: LoggerService = new LoggerService(
    'StuckAnalysisService',
  );

  constructor(
    private prisma: PrismaService,
    private dashboard: TeamDashboardService,
  ) {}

  /** One run for one team. */
  async analyzeTeam(teamId: string): Promise<{ analyzed: number }> {
    const stuck = await this.dashboard.getStuck(teamId);

    // A finding for an issue that left its state, or fell under its
    // threshold, is out of date.
    await this.prisma.stuckIssueFinding.deleteMany({
      where: { teamId, issueId: { notIn: stuck.map((issue) => issue.id) } },
    });
    if (stuck.length === 0) {
      return { analyzed: 0 };
    }

    if (!isLLMConfigured()) {
      this.logger.warn({
        message: `The system LLM is not configured, so team ${teamId} is not analyzed`,
        where: 'StuckAnalysisService.analyzeTeam',
      });
      return { analyzed: 0 };
    }

    const evidence = await this.loadEvidence(stuck.map((issue) => issue.id));
    const existing = await this.prisma.stuckIssueFinding.findMany({
      where: { teamId },
      select: { issueId: true, fingerprint: true },
    });
    const known = new Map(
      existing.map((row) => [row.issueId, row.fingerprint]),
    );

    const todo = stuck
      .map((issue) => ({
        issue,
        fingerprint: fingerprint(issue, evidence.get(issue.id)),
      }))
      .filter(({ issue, fingerprint }) => known.get(issue.id) !== fingerprint)
      .slice(0, analysisMaxIssues());

    let analyzed = 0;
    let failures = 0;
    for (const { issue, fingerprint } of todo) {
      try {
        if (await this.analyzeIssue(teamId, issue, fingerprint)) {
          analyzed += 1;
        }
        failures = 0;
      } catch (error) {
        failures += 1;
        this.logger.error({
          message: `Could not analyze issue ${issue.id}: ${error}`,
          where: 'StuckAnalysisService.analyzeTeam',
          error: error instanceof Error ? error : undefined,
        });
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          this.logger.error({
            message: `Stopped the analysis of team ${teamId} after ${failures} failed model calls in a row`,
            where: 'StuckAnalysisService.analyzeTeam',
          });
          break;
        }
      }
    }
    return { analyzed };
  }

  /** Whether a finding was stored. An unreadable answer stores nothing. */
  private async analyzeIssue(
    teamId: string,
    issue: StuckIssue,
    fingerprint: string,
  ): Promise<boolean> {
    const input = await this.loadContext(teamId, issue);
    const { text, model } = await generateModelText({
      purpose: STUCK_PURPOSE,
      tier: 'default',
      system: STUCK_SYSTEM,
      prompt: buildStuckPrompt(input),
      temperature: 0.2,
    });

    const answer = parseStuckAnswer(text);
    if (!answer) {
      this.logger.warn({
        message: `The model gave no readable answer for issue ${issue.id}`,
        where: 'StuckAnalysisService.analyzeIssue',
      });
      return false;
    }

    const data = {
      teamId,
      fingerprint,
      stateId: issue.stateId,
      stateEnteredAt: new Date(issue.stateEnteredAt),
      cause: answer.cause,
      category: answer.category,
      suggestions: answer.suggestions as Prisma.InputJsonValue,
      confidence: answer.confidence ?? null,
      model: model ?? null,
    };
    await this.prisma.stuckIssueFinding.upsert({
      where: { issueId: issue.id },
      create: { issueId: issue.id, ...data },
      update: data,
    });
    return true;
  }

  /** What changes a finding's meaning, for all stuck issues in four reads. */
  private async loadEvidence(
    issueIds: string[],
  ): Promise<Map<string, Evidence>> {
    const [issues, comments, links] = await Promise.all([
      this.prisma.issue.findMany({
        where: { id: { in: issueIds } },
        select: { id: true, updatedAt: true },
      }),
      this.prisma.issueComment.findMany({
        where: { issueId: { in: issueIds }, deleted: null },
        orderBy: { createdAt: 'desc' },
        distinct: ['issueId'],
        select: { id: true, issueId: true },
      }),
      this.prisma.linkedIssue.findMany({
        where: { issueId: { in: issueIds }, deleted: null },
        orderBy: { createdAt: 'asc' },
        select: { issueId: true, url: true, sourceData: true },
      }),
    ]);

    const result = new Map<string, Evidence>();
    for (const issue of issues) {
      result.set(issue.id, {
        updatedAt: issue.updatedAt,
        latestCommentId: null,
        links: [],
      });
    }
    for (const comment of comments) {
      const entry = result.get(comment.issueId);
      if (entry) {
        entry.latestCommentId = comment.id;
      }
    }
    for (const link of links) {
      result.get(link.issueId)?.links.push(link);
    }
    return result;
  }

  /** Everything the model sees about one issue. */
  private async loadContext(
    teamId: string,
    stuck: StuckIssue,
  ): Promise<StuckPromptInput> {
    const [issue, team, comments, history, relations, links, workflows] =
      await Promise.all([
        this.prisma.issue.findUnique({
          where: { id: stuck.id },
          select: { description: true, priority: true, estimate: true },
        }),
        this.prisma.team.findUnique({
          where: { id: teamId },
          select: { identifier: true },
        }),
        this.prisma.issueComment.findMany({
          where: { issueId: stuck.id, deleted: null },
          orderBy: { createdAt: 'desc' },
          take: COMMENT_COUNT,
          select: { userId: true, createdAt: true, body: true },
        }),
        this.prisma.issueHistory.findMany({
          where: {
            issueId: stuck.id,
            deleted: null,
            OR: [
              { toStateId: { not: null } },
              { toAssigneeId: { not: null } },
              { fromAssigneeId: { not: null } },
            ],
          },
          orderBy: { createdAt: 'desc' },
          take: HISTORY_COUNT,
          select: {
            createdAt: true,
            updatedAt: true,
            fromStateId: true,
            toStateId: true,
            fromAssigneeId: true,
            toAssigneeId: true,
          },
        }),
        this.prisma.issueRelation.findMany({
          where: { issueId: stuck.id, type: 'BLOCKED', deleted: null },
          select: { relatedIssueId: true },
        }),
        this.prisma.linkedIssue.findMany({
          where: { issueId: stuck.id, deleted: null },
          orderBy: { createdAt: 'asc' },
          select: { url: true, sourceData: true },
        }),
        this.prisma.workflow.findMany({
          where: { teamId },
          select: { id: true, name: true },
        }),
      ]);

    const blockers = relations.length
      ? await this.prisma.issue.findMany({
          where: {
            id: { in: relations.map((row) => row.relatedIssueId) },
            deleted: null,
          },
          select: {
            number: true,
            title: true,
            stateId: true,
            team: { select: { identifier: true } },
          },
        })
      : [];
    const blockerStates = await this.prisma.workflow.findMany({
      where: { id: { in: blockers.map((blocker) => blocker.stateId) } },
      select: { id: true, name: true },
    });

    const stateNames = new Map(
      [...workflows, ...blockerStates].map((state) => [state.id, state.name]),
    );
    const userIds = [
      stuck.assigneeId,
      ...comments.map((comment) => comment.userId),
      ...history.flatMap((row) => [row.fromAssigneeId, row.toAssigneeId]),
    ].filter((id): id is string => Boolean(id));
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: [...new Set(userIds)] } },
          select: { id: true, fullname: true, username: true },
        })
      : [];
    const names = new Map(
      users.map((user) => [user.id, user.fullname ?? user.username]),
    );
    const nameOf = (id: string | null | undefined) =>
      (id ? names.get(id) : null) ?? 'someone';
    const stateOf = (id: string | null | undefined) =>
      (id ? stateNames.get(id) : null) ?? 'unknown';

    return {
      key: `${team?.identifier ?? 'ISSUE'}-${stuck.number}`,
      title: stuck.title,
      description: issue?.description
        ? cut(convertTiptapJsonToMarkdown(issue.description), DESCRIPTION_CHARS)
        : null,
      state: stateOf(stuck.stateId),
      hoursInState: stuck.hoursInState,
      thresholdHours: stuck.thresholdHours,
      assignee: stuck.assigneeId ? nameOf(stuck.assigneeId) : null,
      priority:
        issue?.priority == null
          ? null
          : (priorityNames[issue.priority] ?? null),
      estimate: issue?.estimate ?? null,
      comments: comments.reverse().map((comment) => ({
        author: nameOf(comment.userId),
        at: comment.createdAt,
        body: cut(
          convertTiptapJsonToMarkdown(comment.body).trim(),
          COMMENT_CHARS,
        ),
      })),
      history: history.reverse().map((row) => ({
        at: row.toStateId ? moveTime(row) : row.createdAt,
        text: describeChange(row, stateOf, nameOf),
      })),
      blockers: blockers.map((blocker) => ({
        key: `${blocker.team.identifier}-${blocker.number}`,
        title: blocker.title,
        state: stateOf(blocker.stateId),
      })),
      links: links.map((link) => ({
        url: link.url,
        state: linkState(link.sourceData),
      })),
    };
  }
}

function describeChange(
  row: {
    fromStateId: string | null;
    toStateId: string | null;
    fromAssigneeId: string | null;
    toAssigneeId: string | null;
  },
  stateOf: (id: string | null) => string,
  nameOf: (id: string | null) => string,
): string {
  const parts: string[] = [];
  if (row.toStateId) {
    parts.push(
      row.fromStateId
        ? `moved from ${stateOf(row.fromStateId)} to ${stateOf(row.toStateId)}`
        : `moved to ${stateOf(row.toStateId)}`,
    );
  }
  if (row.toAssigneeId) {
    parts.push(`assigned to ${nameOf(row.toAssigneeId)}`);
  } else if (row.fromAssigneeId) {
    parts.push('unassigned');
  }
  return parts.join(', ');
}

/** The state a linked item reports, when its source data carries one. */
function linkState(sourceData: unknown): string | null {
  if (sourceData && typeof sourceData === 'object') {
    const state = (sourceData as Record<string, unknown>).state;
    if (typeof state === 'string' && state.trim()) {
      return state.trim();
    }
  }
  return null;
}

/**
 * A hash of what the model would see change: the state and when it was
 * entered, the issue's last edit, the newest comment and the linked items.
 */
export function fingerprint(
  issue: Pick<StuckIssue, 'stateId' | 'stateEnteredAt'>,
  evidence: Evidence | undefined,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        issue.stateId,
        issue.stateEnteredAt,
        evidence?.updatedAt.toISOString() ?? null,
        evidence?.latestCommentId ?? null,
        (evidence?.links ?? []).map((link) => [link.url, link.sourceData]),
      ]),
    )
    .digest('hex');
}
