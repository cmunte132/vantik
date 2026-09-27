import { Injectable } from '@nestjs/common';
import { WorkflowCategory } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { ensureIntegrationBot } from 'modules/integration-events/integration-bot';
import IssuesService from 'modules/issues/issues.service';

/** The label every issue the gardener opens carries. */
export const KNOWLEDGE_LABEL = 'knowledge';

/** Who the gardener's issues are by: one bot member per workspace. */
export const KNOWLEDGE_BOT = {
  slug: 'vantik-knowledge',
  name: 'Knowledge gardener',
  icon: 'bot',
};

/**
 * Where an issue waits for a person to pick it up, most preferred first. A
 * gardener's issue is a request, not planned work, so it goes where requests
 * are looked at.
 */
const OPENING_CATEGORIES: WorkflowCategory[] = [
  WorkflowCategory.TRIAGE,
  WorkflowCategory.BACKLOG,
  WorkflowCategory.UNSTARTED,
];

/** An issue to open. */
export interface KnowledgeIssue {
  workspaceId: string;
  /** The modules it is about, the one whose owner should see it first. */
  moduleIds: string[];
  title: string;
  markdown: string;
}

/**
 * Opens the issues the gardener raises: a claim the code now contradicts, a
 * question the knowledge could not answer.
 *
 * Each goes to the team that owns the module it is about, labelled
 * `knowledge`, with no assignee: it is never delegated from here, and a
 * person or an automation the team already runs decides who takes it. It is
 * opened through the same path a person's issue is, so numbering,
 * notifications and the team's own triage all apply.
 */
@Injectable()
export default class KnowledgeIssues {
  constructor(
    private prisma: PrismaService,
    private issues: IssuesService,
  ) {}

  /** The issue opened, or null when the workspace has no team to hold it. */
  async open(issue: KnowledgeIssue): Promise<{ id: string } | null> {
    const teamId = await this.owningTeam(issue.workspaceId, issue.moduleIds);

    if (!teamId) {
      return null;
    }

    const states = await this.prisma.workflow.findMany({
      where: { teamId, deleted: null },
      orderBy: { position: 'asc' },
      select: { id: true, category: true },
    });
    const state =
      OPENING_CATEGORIES.map((category) =>
        states.find((candidate) => candidate.category === category),
      ).find(Boolean) ?? states[0];

    if (!state) {
      return null;
    }

    const label = await this.label(issue.workspaceId);
    const authorId = await ensureIntegrationBot(
      this.prisma,
      issue.workspaceId,
      KNOWLEDGE_BOT,
    );
    const moduleIds = await this.liveModules(
      issue.workspaceId,
      issue.moduleIds,
    );
    const created = await this.issues.createIssueAPI(
      {
        teamId,
        stateId: state.id,
        title: issue.title,
        descriptionMarkdown: issue.markdown,
        labelIds: [label],
        ...(moduleIds.length ? { moduleIds } : {}),
      },
      authorId,
    );

    return { id: created.id };
  }

  /**
   * The team that should see an issue about these modules.
   *
   * The first module's owning team, when a team owns it. A module a product
   * owns has no team of its own, and a product has no default team, so the
   * team that works on it stands in: the first live team it links, then the
   * team with the most issues in these modules. A workspace where none of
   * that answers gets its oldest team, so the issue is never lost for want
   * of an owner.
   */
  async owningTeam(
    workspaceId: string,
    moduleIds: string[],
  ): Promise<string | null> {
    const teams = new Set(
      (
        await this.prisma.team.findMany({
          where: { workspaceId, deleted: null },
          select: { id: true },
        })
      ).map((team) => team.id),
    );

    if (moduleIds.length) {
      const modules = await this.prisma.module.findMany({
        where: { id: { in: moduleIds }, workspaceId, deleted: null },
        select: { id: true, ownerTeamId: true, linkedTeamIds: true },
      });
      const ordered = moduleIds.flatMap((id): typeof modules =>
        modules.filter((module) => module.id === id),
      );

      for (const candidate of [
        ...ordered.map((module) => module.ownerTeamId),
        ...ordered.flatMap((module) => module.linkedTeamIds),
      ]) {
        if (candidate && teams.has(candidate)) {
          return candidate;
        }
      }

      const busiest = await this.prisma.issue.groupBy({
        by: ['teamId'],
        where: {
          deleted: null,
          moduleIds: { hasSome: moduleIds },
          team: { workspaceId, deleted: null },
        },
        _count: { _all: true },
        orderBy: { _count: { teamId: 'desc' } },
        take: 1,
      });

      if (busiest[0] && teams.has(busiest[0].teamId)) {
        return busiest[0].teamId;
      }
    }

    const oldest = await this.prisma.team.findFirst({
      where: { workspaceId, deleted: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    return oldest?.id ?? null;
  }

  /**
   * The workspace's `knowledge` label, made on first use. A person who
   * deleted it gets it back: the issues it marks are what tells a team the
   * knowledge its agents read needs a person.
   */
  private async label(workspaceId: string): Promise<string> {
    const label = await this.prisma.label.upsert({
      where: { name_workspaceId: { name: KNOWLEDGE_LABEL, workspaceId } },
      update: { deleted: null },
      create: {
        name: KNOWLEDGE_LABEL,
        color: '#8b5cf6',
        description:
          'Opened by the knowledge gardener: knowledge agents read needs a person.',
        workspaceId,
      },
      select: { id: true },
    });

    return label.id;
  }

  private async liveModules(
    workspaceId: string,
    moduleIds: string[],
  ): Promise<string[]> {
    if (!moduleIds.length) {
      return [];
    }

    const live = new Set(
      (
        await this.prisma.module.findMany({
          where: { id: { in: moduleIds }, workspaceId, deleted: null },
          select: { id: true },
        })
      ).map((module) => module.id),
    );

    return moduleIds.filter((id) => live.has(id));
  }
}
