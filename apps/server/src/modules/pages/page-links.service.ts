import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PageLinkTypeEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

/**
 * The page graph.
 *
 * Nesting gives a page one parent, which cannot express "this runbook belongs
 * to the Payments project and the Platform team". These edges can, and the
 * reverse index on (entityType, entityId) is what makes them worth having: an
 * agent holding an issue can find the documentation for it as a lookup, rather
 * than by guessing search terms or scanning every issue body in the workspace.
 */

export interface ResolvedLink {
  id: string;
  pageId: string;
  entityType: PageLinkTypeEnum;
  entityId: string;
  /** What to call the target: an issue key, a project or team name, a title. */
  label: string;
  /** Present for issues, so a caller can build a route without another read. */
  teamId?: string;
}

export interface RelatedPage {
  id: string;
  title: string;
  entityType: PageLinkTypeEnum;
  entityId: string;
}

@Injectable()
export default class PageLinksService {
  constructor(private prisma: PrismaService) {}

  /**
   * Everything this page is linked to, with the dead edges dropped.
   *
   * `entityId` cannot be a foreign key — one column will not reference four
   * tables — so a target can be deleted out from under an edge. Reads resolve
   * every target and omit what no longer exists, rather than handing the caller
   * a link that goes nowhere.
   */
  async getLinks(pageId: string, workspaceId: string): Promise<ResolvedLink[]> {
    const links = await this.prisma.pageLink.findMany({
      where: { pageId, deleted: null },
      orderBy: { createdAt: 'asc' },
    });

    return this.resolve(links, workspaceId);
  }

  /**
   * The other direction: pages linked to one team, project, issue or page.
   *
   * This is the half that the substring scan over issue descriptions could
   * never do, and the reason an agent can be handed a project's documentation
   * without being told what it is called.
   */
  async getRelatedPages(
    entityType: PageLinkTypeEnum,
    entityId: string,
    workspaceId: string,
  ): Promise<RelatedPage[]> {
    const links = await this.prisma.pageLink.findMany({
      where: {
        entityType,
        entityId,
        deleted: null,
        page: { deleted: null, workspaceId },
      },
      select: {
        entityType: true,
        entityId: true,
        page: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return links.map((link) => ({
      id: link.page.id,
      title: link.page.title,
      entityType: link.entityType as PageLinkTypeEnum,
      entityId: link.entityId,
    }));
  }

  async createLink(
    pageId: string,
    workspaceId: string,
    userId: string,
    input: { entityType: PageLinkTypeEnum; entityId: string },
  ): Promise<ResolvedLink> {
    if (input.entityType === PageLinkTypeEnum.PAGE && input.entityId === pageId) {
      throw new BadRequestException({
        message: 'A page cannot be linked to itself.',
      });
    }

    // Checked before writing, so a typo becomes an error rather than an edge
    // that silently resolves to nothing on every later read.
    const label = await this.labelFor(input.entityType, input.entityId, workspaceId);

    if (!label) {
      throw new NotFoundException({
        message:
          `No ${input.entityType.toLowerCase()} ${input.entityId} in this ` +
          'workspace.',
      });
    }

    // The same edge twice is not two facts about the graph, so a repeat link is
    // the existing one rather than a conflict the caller has to handle.
    const link = await this.prisma.pageLink.upsert({
      where: {
        pageId_entityType_entityId: {
          pageId,
          entityType: input.entityType,
          entityId: input.entityId,
        },
      },
      update: { deleted: null },
      create: {
        pageId,
        entityType: input.entityType,
        entityId: input.entityId,
        createdById: userId,
      },
    });

    const [resolved] = await this.resolve([link], workspaceId);
    return resolved;
  }

  /**
   * Scoped by page, not by link id alone.
   *
   * The route guard checks the page, and the page is what ties this to a
   * workspace — a bare id would let a link on someone else's page be deleted by
   * anyone who could guess a uuid.
   */
  async deleteLink(
    pageId: string,
    linkId: string,
    workspaceId: string,
  ): Promise<{ id: string }> {
    const link = await this.prisma.pageLink.findFirst({
      where: {
        id: linkId,
        pageId,
        deleted: null,
        page: { workspaceId, deleted: null },
      },
      select: { id: true },
    });

    if (!link) {
      throw new NotFoundException({
        message: `No link ${linkId} on page ${pageId}`,
      });
    }

    await this.prisma.pageLink.update({
      where: { id: linkId },
      data: { deleted: new Date() },
    });

    return { id: linkId };
  }

  // --------------------------------------------------------------- internals

  /**
   * Labels a batch of edges, one query per kind rather than one per edge.
   *
   * A page with twenty links would otherwise be twenty round trips to render a
   * sidebar section.
   */
  private async resolve(
    links: Array<{
      id: string;
      pageId: string;
      entityType: string;
      entityId: string;
    }>,
    workspaceId: string,
  ): Promise<ResolvedLink[]> {
    const idsOf = (type: PageLinkTypeEnum) =>
      links
        .filter((link) => link.entityType === type)
        .map((link) => link.entityId);

    const [teams, projects, issues, pages] = await Promise.all([
      this.prisma.team.findMany({
        where: { id: { in: idsOf(PageLinkTypeEnum.TEAM) }, workspaceId, deleted: null },
        select: { id: true, name: true },
      }),
      this.prisma.project.findMany({
        where: { id: { in: idsOf(PageLinkTypeEnum.PROJECT) }, workspaceId, deleted: null },
        select: { id: true, name: true },
      }),
      this.prisma.issue.findMany({
        where: {
          id: { in: idsOf(PageLinkTypeEnum.ISSUE) },
          deleted: null,
          team: { workspaceId },
        },
        select: {
          id: true,
          title: true,
          number: true,
          teamId: true,
          team: { select: { identifier: true } },
        },
      }),
      this.prisma.page.findMany({
        where: { id: { in: idsOf(PageLinkTypeEnum.PAGE) }, workspaceId, deleted: null },
        select: { id: true, title: true },
      }),
    ]);

    const labels = new Map<string, { label: string; teamId?: string }>();
    const key = (type: PageLinkTypeEnum, id: string) => `${type}:${id}`;

    teams.forEach((team) =>
      labels.set(key(PageLinkTypeEnum.TEAM, team.id), { label: team.name }),
    );
    projects.forEach((project) =>
      labels.set(key(PageLinkTypeEnum.PROJECT, project.id), {
        label: project.name,
      }),
    );
    issues.forEach((issue) =>
      labels.set(key(PageLinkTypeEnum.ISSUE, issue.id), {
        label: `${issue.team.identifier}-${issue.number} ${issue.title}`,
        teamId: issue.teamId,
      }),
    );
    pages.forEach((page) =>
      labels.set(key(PageLinkTypeEnum.PAGE, page.id), {
        label: page.title || 'Untitled page',
      }),
    );

    return links
      .map((link) => {
        const type = link.entityType as PageLinkTypeEnum;
        const resolved = labels.get(key(type, link.entityId));

        if (!resolved) {
          return null;
        }

        return {
          id: link.id,
          pageId: link.pageId,
          entityType: type,
          entityId: link.entityId,
          label: resolved.label,
          ...(resolved.teamId ? { teamId: resolved.teamId } : {}),
        };
      })
      .filter(Boolean) as ResolvedLink[];
  }

  private async labelFor(
    entityType: PageLinkTypeEnum,
    entityId: string,
    workspaceId: string,
  ): Promise<string | null> {
    if (entityType === PageLinkTypeEnum.TEAM) {
      const team = await this.prisma.team.findFirst({
        where: { id: entityId, workspaceId, deleted: null },
        select: { name: true },
      });
      return team?.name ?? null;
    }

    if (entityType === PageLinkTypeEnum.PROJECT) {
      const project = await this.prisma.project.findFirst({
        where: { id: entityId, workspaceId, deleted: null },
        select: { name: true },
      });
      return project?.name ?? null;
    }

    if (entityType === PageLinkTypeEnum.ISSUE) {
      const issue = await this.prisma.issue.findFirst({
        where: { id: entityId, deleted: null, team: { workspaceId } },
        select: { title: true },
      });
      return issue?.title ?? null;
    }

    const page = await this.prisma.page.findFirst({
      where: { id: entityId, workspaceId, deleted: null },
      select: { title: true },
    });
    return page ? page.title || 'Untitled page' : null;
  }
}
