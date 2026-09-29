import { createHash } from 'node:crypto';

import { Injectable, Optional } from '@nestjs/common';
import { PageLinkType, Prisma } from '@prisma/client';
import {
  PageEntryStatusEnum,
  PageKindEnum,
  type PageSection,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { onLivePageOrLoose } from 'common/page-entry-where';

import { convertMarkdownToTiptapJson } from 'common/utils/tiptap.utils';

import { LoggerService } from 'modules/logger/logger.service';
import { SERVED_STATUSES } from 'modules/vector/vector.interface';
import { VectorService } from 'modules/vector/vector.service';

import KnowledgeIndexService from '../knowledge-index.service';
import { knowledgeSettings } from '../knowledge-settings';
import PageWriter, { type WriterEntry } from './page-writer';
import {
  applyOperations,
  citedBy,
  readSections,
  renderSections,
  sectionEvidence,
  type SectionOperation,
} from './sections';

/**
 * Keeping generated pages current.
 *
 * A generated page answers a question from the entries in its scope: those
 * on the page, and those in the modules its links name. It is rebuilt only
 * when that evidence has changed since its last build, and no sooner than
 * the workspace's minimum interval after it; otherwise nothing is read,
 * called or written. A rebuild is a set of edits to the page's sections by
 * id, made by a model and applied in code, so what no edit names stays as it
 * was; and one that cannot read its evidence, or cannot read the model's
 * answer, writes nothing. Every rebuild stored records the body and the
 * sections it replaced in the page's history, which the existing revert
 * restores.
 *
 * A section whose every cited entry has gone out of use is removed in code,
 * before any model is asked, and without a model this is the part that
 * still runs, so the page does not go on serving what its evidence no longer
 * says. New evidence then waits for a model, served meanwhile as the entries
 * it is. With a model, the removal is part of the refresh, and a refresh
 * whose retrieval is empty writes nothing at all, removals included.
 *
 * The model may rewrite or remove only a section whose evidence changed
 * since it was written: its question, or what an entry it cites says, or an
 * entry leaving use or scope. Every other section it can only add to, with a
 * section of its own, so no answer rewrites the page whole.
 */

/** The statuses whose entries a page may rest on: those still served. */
export const IN_USE: PageEntryStatusEnum[] = SERVED_STATUSES;

/** How many entries one refresh reads: enough for a page, few enough to read. */
const EVIDENCE_LIMIT = 40;

/** Why a refresh ended as it did. */
export type RefreshOutcome =
  | 'not-generated'
  | 'too-soon'
  | 'unchanged'
  | 'no-evidence'
  | 'retrieval-failed'
  | 'writer-failed'
  | 'no-change'
  | 'raced'
  | 'written';

export interface RefreshResult {
  outcome: RefreshOutcome;
  /** The operations applied, code's and the model's, when written. */
  applied?: number;
  /** The model's operations that were dropped. */
  dropped?: number;
}

const PAGE_SELECT = {
  id: true,
  workspaceId: true,
  kind: true,
  question: true,
  description: true,
  sections: true,
  watermark: true,
  evidenceHash: true,
  refreshedAt: true,
  updatedAt: true,
  workspace: { select: { preferences: true } },
} as const;

type RefreshedPage = Prisma.PageGetPayload<{ select: typeof PAGE_SELECT }>;

/** A body with nothing in it, which a first build's history row goes back to. */
const EMPTY_BODY = JSON.stringify(convertMarkdownToTiptapJson(''));

@Injectable()
export default class PageRefreshService {
  private readonly logger = new LoggerService('PageRefreshService');

  constructor(
    private prisma: PrismaService,
    private vectorService: VectorService,
    private writer: PageWriter,
    @Optional() private indexer?: KnowledgeIndexService,
  ) {}

  /** Refreshes every generated page that is due. One failing stops no other. */
  async refreshDue(
    now = new Date(),
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<{ checked: number; written: number }> {
    const pages = await this.prisma.page.findMany({
      where: { kind: PageKindEnum.GENERATED, deleted: null },
      select: { id: true },
      orderBy: { refreshedAt: { sort: 'asc', nulls: 'first' } },
    });
    let written = 0;

    for (const { id } of pages) {
      try {
        const { outcome } = await this.refresh(id, now, env);
        written += outcome === 'written' ? 1 : 0;
      } catch (error) {
        this.logger.error({
          message: `Refreshing generated page ${id} failed`,
          where: 'PageRefreshService.refreshDue',
          error: error instanceof Error ? error : undefined,
        });
      }
    }

    return { checked: pages.length, written };
  }

  /**
   * Refreshes one generated page, if it is due.
   *
   * The gate is read before anything else: the interval since the last build
   * first, as it costs nothing, then whether the evidence changed. Neither
   * writes anything when the page is not due.
   */
  async refresh(
    pageId: string,
    now = new Date(),
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<RefreshResult> {
    const page = await this.prisma.page.findFirst({
      where: { id: pageId, deleted: null },
      select: PAGE_SELECT,
    });

    if (!page || page.kind !== PageKindEnum.GENERATED || !page.question) {
      return { outcome: 'not-generated' };
    }

    const { pageRefreshMinIntervalMs } = knowledgeSettings(
      page.workspace?.preferences,
      env,
    );

    if (
      page.refreshedAt &&
      now.getTime() - page.refreshedAt.getTime() < pageRefreshMinIntervalMs
    ) {
      return { outcome: 'too-soon' };
    }

    const modules = await this.scopeModules(page);
    const scope = this.scopeWhere(page, modules);
    const changedAt = await this.evidenceChangedAt(page.id, scope);

    if (!changedAt || (page.watermark && changedAt <= page.watermark)) {
      return { outcome: 'unchanged' };
    }

    const evidenceHash = await this.evidenceHash(scope);

    if (evidenceHash === page.evidenceHash) {
      return { outcome: 'unchanged' };
    }

    const current = readSections(page.sections);
    const citedRows = await this.citedEntries(page, modules, citedBy(current));
    const cited = new Set(citedRows.map((entry) => entry.id));

    // In code, and before any model: a section resting only on entries no
    // longer in use says what its evidence no longer says.
    const removals: SectionOperation[] = current
      .filter((section) => section.entryIds.every((id) => !cited.has(id)))
      .map((section) => ({ op: 'remove_section', id: section.id }));
    const kept = applyOperations(current, removals, new Set()).sections;

    if (!this.writer.available()) {
      // New evidence needs a model to be written up. The watermark stays
      // where it was, so a model folds it in once there is one.
      return removals.length
        ? this.write(page, kept, removals, 0, now, null)
        : { outcome: 'no-change' };
    }

    let found: WriterEntry[];

    try {
      found = await this.retrieve(page, page.question, modules);
    } catch (error) {
      this.logger.warn({
        message: `Could not read the evidence for generated page ${page.id}: nothing written`,
        where: 'PageRefreshService.refresh',
        error: error instanceof Error ? error : undefined,
      });

      return { outcome: 'retrieval-failed' };
    }

    if (found.length === 0) {
      return { outcome: 'no-evidence' };
    }

    // What the kept sections rest on is read too, found by the search or
    // not, so a section can be rewritten from the entries it still has.
    const evidence = [
      ...found,
      ...citedRows.filter((entry) => !found.some((hit) => hit.id === entry.id)),
    ];
    const question = page.question;
    const inUse = new Map(citedRows.map((entry) => [entry.id, entry]));
    const editable = kept
      .filter(
        (section) =>
          section.evidence !==
          sectionEvidence(question, section.entryIds, inUse),
      )
      .map((section) => section.id);

    let operations: unknown[] | null;

    try {
      operations = (
        await this.writer.operations({
          question: page.question,
          sections: kept,
          editable,
          evidence,
          outOfUse: citedBy(kept).filter((id) => !cited.has(id)),
        })
      ).operations;
    } catch (error) {
      this.logger.warn({
        message: `The writer failed for generated page ${page.id}: nothing written`,
        where: 'PageRefreshService.refresh',
        error: error instanceof Error ? error : undefined,
      });

      return { outcome: 'writer-failed' };
    }

    if (operations === null) {
      return { outcome: 'writer-failed' };
    }

    const read = new Map(evidence.map((entry) => [entry.id, entry]));
    const edited = applyOperations(
      kept,
      operations,
      new Set(read.keys()),
      undefined,
      {
        editable: new Set(editable),
        stamp: (entryIds) => sectionEvidence(question, entryIds, read),
      },
    );
    const applied = [...removals, ...edited.applied];

    return this.write(
      page,
      edited.sections,
      applied,
      edited.dropped.length,
      now,
      {
        watermark: changedAt,
        evidenceHash,
      },
    );
  }

  /**
   * Stores a refresh: the sections, the body rendered from them, what the
   * page cites, and the history row that shows it and can undo it, in one
   * transaction. The row is written for every refresh stored, with the body
   * and sections it replaced, including one that changed nothing, which
   * records the edits it dropped. Only over the page as it was read
   * (`updatedAt` unchanged), so two refreshes of one page never both write,
   * and neither does one racing a person's edit or revert. `seen` advances
   * the watermark; a refresh that did not read the evidence (no model)
   * leaves it.
   */
  private async write(
    page: RefreshedPage,
    sections: PageSection[],
    applied: SectionOperation[],
    dropped: number,
    now: Date,
    seen: { watermark: Date; evidenceHash: string } | null,
  ): Promise<RefreshResult> {
    const changed = applied.length > 0;

    const written = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.page.updateMany({
        where: {
          id: page.id,
          kind: PageKindEnum.GENERATED,
          deleted: null,
          updatedAt: page.updatedAt,
        },
        data: {
          refreshedAt: now,
          ...(seen ?? {}),
          ...(changed
            ? {
                sections: sections as unknown as Prisma.InputJsonValue,
                description: JSON.stringify(
                  convertMarkdownToTiptapJson(renderSections(sections)),
                ),
                citedEntryIds: citedBy(sections),
              }
            : {}),
        },
      });

      if (count === 0) {
        return false;
      }

      await tx.pageHistory.create({
        data: {
          pageId: page.id,
          userId: null,
          changes: {
            ...(changed ? { body: true } : {}),
            refreshed: { operations: applied.length, dropped },
          },
          previousBody: page.description ?? EMPTY_BODY,
          previousSections: (page.sections ??
            []) as unknown as Prisma.InputJsonValue,
        },
      });

      return true;
    });

    if (!written) {
      return { outcome: 'raced' };
    }

    if (changed) {
      await this.indexer?.pageChanged(page.id);
    }

    return changed
      ? { outcome: 'written', applied: applied.length, dropped }
      : { outcome: 'no-change', dropped };
  }

  /**
   * The modules the page's links name: a module itself, a product's modules
   * (owned or linked), a capability's. Links to anything else say nothing
   * about which code the page is about.
   */
  private async scopeModules(page: RefreshedPage): Promise<string[]> {
    const links = await this.prisma.pageLink.findMany({
      where: {
        pageId: page.id,
        deleted: null,
        entityType: {
          in: [
            PageLinkType.MODULE,
            PageLinkType.PRODUCT,
            PageLinkType.CAPABILITY,
          ],
        },
      },
      select: { entityType: true, entityId: true },
    });
    const of = (type: PageLinkType) =>
      links
        .filter((link) => link.entityType === type)
        .map((link) => link.entityId);

    if (links.length === 0) {
      return [];
    }

    const capabilities = of(PageLinkType.CAPABILITY).length
      ? await this.prisma.capability.findMany({
          where: {
            id: { in: of(PageLinkType.CAPABILITY) },
            workspaceId: page.workspaceId,
            deleted: null,
          },
          select: { moduleIds: true },
        })
      : [];
    const products = of(PageLinkType.PRODUCT);
    const modules = await this.prisma.module.findMany({
      where: {
        workspaceId: page.workspaceId,
        deleted: null,
        OR: [
          {
            id: {
              in: [
                ...of(PageLinkType.MODULE),
                ...capabilities.flatMap((capability) => capability.moduleIds),
              ],
            },
          },
          ...(products.length
            ? [
                { ownerProductId: { in: products } },
                { linkedProductIds: { hasSome: products } },
              ]
            : []),
        ],
      },
      select: { id: true },
    });

    return modules.map((productModule) => productModule.id);
  }

  /**
   * The page's evidence: its own entries, and those of its modules, loose
   * or on any page. `live` narrows it to entries in use on pages not deleted
   * and loose entries in use; without it, an entry
   * leaving use is still in scope, as a change.
   */
  private scopeWhere(
    page: RefreshedPage,
    modules: string[],
    live = false,
  ): Prisma.PageEntryWhereInput {
    return {
      workspaceId: page.workspaceId,
      ...(live ? onLivePageOrLoose() : {}),
      ...(live ? { deleted: null, status: { in: IN_USE } } : {}),
      OR: [
        { pageId: page.id },
        ...(modules.length ? [{ moduleIds: { hasSome: modules } }] : []),
      ],
    };
  }

  /**
   * The watermark: the latest `updatedAt` among the entries in scope, in any
   * status and deleted or not (an entry leaving use is a change), and among
   * the page's links, which decide the scope.
   */
  private async evidenceChangedAt(
    pageId: string,
    scope: Prisma.PageEntryWhereInput,
  ): Promise<Date | null> {
    const [entries, links] = await Promise.all([
      this.prisma.pageEntry.aggregate({
        where: scope,
        _max: { updatedAt: true },
      }),
      this.prisma.pageLink.aggregate({
        where: { pageId },
        _max: { updatedAt: true },
      }),
    ]);
    const times = [entries._max.updatedAt, links._max.updatedAt].filter(
      (time): time is Date => time instanceof Date,
    );

    return times.length
      ? new Date(Math.max(...times.map((time) => time.getTime())))
      : null;
  }

  /**
   * What the evidence says, as a hash: each entry in scope by id, status,
   * kind, content and whether it is deleted. Serving an entry moves its
   * `updatedAt` without changing any of these. The links are not hashed:
   * they decide which entries are in scope, and a link that brings in or
   * takes away none changes nothing the page could say.
   */
  private async evidenceHash(
    scope: Prisma.PageEntryWhereInput,
  ): Promise<string> {
    const entries = await this.prisma.pageEntry.findMany({
      where: scope,
      select: {
        id: true,
        status: true,
        kind: true,
        content: true,
        deleted: true,
      },
      orderBy: { id: 'asc' },
    });

    return createHash('sha256')
      .update(
        JSON.stringify(
          entries.map((entry) => [
            entry.id,
            entry.status,
            entry.kind,
            entry.content,
            entry.deleted !== null,
          ]),
        ),
      )
      .digest('hex');
  }

  /**
   * The entries the page cites that are still in use and in its scope. One
   * that left either no longer says anything the page may rest on.
   */
  private async citedEntries(
    page: RefreshedPage,
    modules: string[],
    ids: string[],
  ): Promise<WriterEntry[]> {
    if (ids.length === 0) {
      return [];
    }

    const rows = await this.prisma.pageEntry.findMany({
      where: { ...this.scopeWhere(page, modules, true), id: { in: ids } },
      select: { id: true, kind: true, content: true },
    });

    return rows.map((row): WriterEntry => ({
      id: row.id,
      kind: row.kind,
      trust: null,
      content: row.content,
    }));
  }

  /**
   * The entries a refresh writes from: those in scope that best answer the
   * question, as the index finds them, confirmed in use from postgres, since
   * the index can be behind. An index that cannot be reached throws, and
   * the refresh writes nothing. Ungrouped, as the scope is the page's own:
   * a module whose facts sit on one page gives up all of them, not three.
   */
  private async retrieve(
    page: RefreshedPage,
    question: string,
    modules: string[],
  ): Promise<WriterEntry[]> {
    const searches = await Promise.all([
      this.vectorService.searchKnowledge(page.workspaceId, question, {
        limit: EVIDENCE_LIMIT,
        pageId: page.id,
        includeStatuses: IN_USE,
        ungrouped: true,
      }),
      ...(modules.length
        ? [
            this.vectorService.searchKnowledge(page.workspaceId, question, {
              limit: EVIDENCE_LIMIT,
              moduleIds: modules,
              includeStatuses: IN_USE,
              ungrouped: true,
            }),
          ]
        : []),
    ]);
    const hits = new Map(
      searches
        .flatMap((search) => search.hits)
        .filter((hit) => hit.entryId)
        .map((hit) => [hit.entryId as string, hit]),
    );

    if (hits.size === 0) {
      return [];
    }

    const ranked = [...hits.keys()];
    const rows = await this.prisma.pageEntry.findMany({
      where: { ...this.scopeWhere(page, modules, true), id: { in: ranked } },
      select: { id: true, kind: true, content: true },
    });

    return rows
      .sort((a, b) => ranked.indexOf(a.id) - ranked.indexOf(b.id))
      .slice(0, EVIDENCE_LIMIT)
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        trust: hits.get(row.id)?.trust ?? null,
        content: row.content,
      }));
  }
}
