import type {
  KnowledgeOverviewLoose,
  LooseFactGroup,
  LooseFactSuggestion,
} from '@vantikhq/types';

import { Injectable } from '@nestjs/common';
import { PageEntryStatus, PageLinkType } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { liveEntryIn } from 'common/page-entry-where';

import { scopePath } from 'modules/modules/module-routing';

/** The statuses of a loose fact that the gardener files: in use, or waiting. */
const FILED = [PageEntryStatus.STANDING, PageEntryStatus.PROPOSED];

/** The statuses of a fact on a page that tells the gardener what the page is about. */
const ON_PAGE = [PageEntryStatus.STANDING, PageEntryStatus.CONSOLIDATED];

/**
 * The number of loose facts with one scope that is enough for a page of
 * their own, when no page fits them.
 */
export const MAKE_PAGE_AT = 5;

/**
 * The lowest score for a page to fit a group. A fact on the page with a
 * scope in the same folder scores 1, and a MODULE link to a module of the
 * group scores `MODULE_LINK_SCORE`. So one link is enough, and so are two
 * facts, but one fact is not.
 */
export const FIT_AT = 2;
export const MODULE_LINK_SCORE = 2;

/** A loose fact, as the gardener reads it. */
export interface LooseFact {
  id: string;
  scope: string | null;
  moduleIds: string[];
}

/** What the gardener knows about one page that a group can go under. */
export interface PageFit {
  id: string;
  title: string;
  /** The scopes of the page's facts in use. */
  scopes: string[];
  /** The modules that the page has a MODULE link to. */
  moduleIds: string[];
}

/**
 * Says if two scope folders are the same folder, or one is in the other.
 * `apps/server` and `apps/server/prisma` match. `apps/server` and
 * `apps/server-extra` do not.
 */
export function sameFolder(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Groups loose facts by the folder of their scope, and gives each group a
 * suggestion. This function is pure, so that the rules have tests.
 *
 * 1. A page fits a group when its score is `FIT_AT` or more. The page with
 *    the highest score wins, and the first page wins a tie.
 * 2. If no page fits and the group has `MAKE_PAGE_AT` facts or more, the
 *    suggestion is a new page. Its title is the name of the module that
 *    every fact of the group is in, or else the scope.
 * 3. Otherwise, no page fits yet.
 */
export function suggestForLooseFacts(
  facts: LooseFact[],
  pages: PageFit[],
  moduleNames: Map<string, string>,
): LooseFactGroup[] {
  const byScope = new Map<string, LooseFact[]>();

  for (const fact of facts) {
    const scope = scopePath(fact.scope) ?? fact.scope?.trim() ?? '';

    byScope.set(scope, [...(byScope.get(scope) ?? []), fact]);
  }

  return [...byScope.entries()]
    .map(([scope, group]) => ({
      scope,
      entryIds: group.map((fact) => fact.id),
      suggestion: suggestion(scope, group, pages, moduleNames),
    }))
    .sort(
      (a, b) =>
        b.entryIds.length - a.entryIds.length || a.scope.localeCompare(b.scope),
    );
}

function suggestion(
  scope: string,
  group: LooseFact[],
  pages: PageFit[],
  moduleNames: Map<string, string>,
): LooseFactSuggestion {
  const modules = new Set(group.flatMap((fact) => fact.moduleIds));
  let best: { page: PageFit; score: number } | null = null;

  for (const page of pages) {
    const score =
      page.scopes.filter((other) => sameFolder(scope, other)).length +
      page.moduleIds.filter((id) => modules.has(id)).length * MODULE_LINK_SCORE;

    if (score >= FIT_AT && (!best || score > best.score)) {
      best = { page, score };
    }
  }

  if (best) {
    return { kind: 'MOVE', pageId: best.page.id, title: best.page.title };
  }

  if (group.length >= MAKE_PAGE_AT) {
    const shared = [...modules].filter((id) =>
      group.every((fact) => fact.moduleIds.includes(id)),
    );
    const title = shared.length === 1 ? moduleNames.get(shared[0]) : undefined;

    return { kind: 'MAKE_PAGE', pageId: null, title: title ?? scope };
  }

  return { kind: 'NONE', pageId: null, title: null };
}

/**
 * The gardener for facts on no page. An agent writes a loose fact when no
 * page fits it. This service finds the page that fits later, or says when
 * enough facts share a scope for a page of their own. A person makes the
 * move: the service only suggests it.
 */
@Injectable()
export default class LooseFactsService {
  constructor(private prisma: PrismaService) {}

  async loose(workspaceId: string): Promise<KnowledgeOverviewLoose> {
    const facts = await this.prisma.pageEntry.findMany({
      where: {
        workspaceId,
        pageId: null,
        deleted: null,
        status: { in: FILED },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, scope: true, moduleIds: true },
    });

    if (facts.length === 0) {
      return { count: 0, groups: [] };
    }

    const [pages, onPages, links, modules] = await Promise.all([
      this.prisma.page.findMany({
        where: { workspaceId, deleted: null },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, title: true },
      }),
      this.prisma.pageEntry.findMany({
        where: {
          ...liveEntryIn(workspaceId),
          pageId: { not: null },
          deleted: null,
          status: { in: ON_PAGE },
          scope: { not: null },
        },
        select: { pageId: true, scope: true },
      }),
      this.prisma.pageLink.findMany({
        where: {
          entityType: PageLinkType.MODULE,
          deleted: null,
          page: { workspaceId, deleted: null },
        },
        select: { pageId: true, entityId: true },
      }),
      this.prisma.module.findMany({
        where: { workspaceId, deleted: null },
        select: { id: true, name: true },
      }),
    ]);

    const fits: PageFit[] = pages.map((page) => ({
      id: page.id,
      title: page.title,
      scopes: onPages
        .filter((entry) => entry.pageId === page.id)
        .map((entry) => scopePath(entry.scope))
        .filter((scope): scope is string => Boolean(scope)),
      moduleIds: links
        .filter((link) => link.pageId === page.id)
        .map((link) => link.entityId),
    }));

    return {
      count: facts.length,
      groups: suggestForLooseFacts(
        facts,
        fits,
        new Map(modules.map((module) => [module.id, module.name])),
      ),
    };
  }

  /** The groups of loose facts that the gardener suggests to move to a page. */
  async fitting(
    workspaceId: string,
    pageId: string,
  ): Promise<LooseFactGroup[]> {
    const { groups } = await this.loose(workspaceId);

    return groups.filter(
      (group) =>
        group.suggestion.kind === 'MOVE' && group.suggestion.pageId === pageId,
    );
  }
}
