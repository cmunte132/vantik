import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ConsolidatePageDto,
  CreatePageDto,
  Page,
  PageEntryStatusEnum,
  UpdatePageDto,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import {
  convertMarkdownToTiptapJson,
  convertTiptapJsonToMarkdown,
} from 'common/utils/tiptap.utils';

import KnowledgeIndexService from './knowledge-index.service';

/**
 * The body to store, from whichever form the caller sent.
 *
 * Markdown is the boundary every non-browser caller uses. The webapp sends
 * tiptap JSON straight through, because its editor already holds that format
 * and round-tripping through markdown to satisfy the API would silently drop
 * whatever markdown cannot express.
 */
function toStoredBody(pageData: {
  description?: string;
  descriptionMarkdown?: string;
}): string | undefined {
  if (pageData.description !== undefined) {
    return pageData.description;
  }

  if (pageData.descriptionMarkdown !== undefined) {
    return JSON.stringify(
      convertMarkdownToTiptapJson(pageData.descriptionMarkdown),
    );
  }

  return undefined;
}

/** A page as the API hands it back: storage shape plus the markdown boundary. */
export type PageResponse = Page & { descriptionMarkdown: string };

/** Everything on a page except its body — see `getPages`. */
const SUMMARY_FIELDS = {
  id: true,
  createdAt: true,
  updatedAt: true,
  deleted: true,
  title: true,
  parentId: true,
  sortOrder: true,
  entryPolicy: true,
  visibility: true,
  workspaceId: true,
  createdById: true,
  updatedById: true,
} as const;

/**
 * One recorded change to a page.
 *
 * `previousBodyMarkdown` is what the body said *before* this change, and is
 * null when the change did not touch the body — a rename, a move, a policy
 * switch. Diffing is left to the reader: the server has no view on how a
 * difference should be presented, and the webapp and a CLI want different ones.
 */
export interface PageRevision {
  id: string;
  pageId: string;
  userId: string | null;
  createdAt: string;
  changes: Record<string, unknown>;
  previousBodyMarkdown: string | null;
}

@Injectable()
export default class PagesService {
  /**
   * `indexer` is optional so unit tests can construct the service with a prisma
   * double alone. Indexing is a cache update, not part of the write — see
   * KnowledgeIndexService.
   */
  constructor(
    private prisma: PrismaService,
    private indexer?: KnowledgeIndexService,
  ) {}

  // ----------------------------------------------------------------- reading

  /**
   * `summary` leaves the bodies out.
   *
   * Resolving a page by title is the commonest reason anything reads this list,
   * and answering that with every document in the workspace — each converted
   * from tiptap JSON to markdown on the way out — costs the whole bank to learn
   * one uuid. Summary rows carry a null body and an empty markdown rendering,
   * so nothing mistakes an omitted body for an empty page.
   */
  async getPages(
    workspaceId: string,
    parentId?: string,
    { summary = false }: { summary?: boolean } = {},
  ): Promise<PageResponse[]> {
    const pages = await this.prisma.page.findMany({
      where: {
        workspaceId,
        deleted: null,
        ...(parentId ? { parentId } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      ...(summary ? { select: SUMMARY_FIELDS } : {}),
    });

    return pages.map((page) =>
      summary
        ? ({
            ...page,
            description: null,
            descriptionMarkdown: '',
          } as PageResponse)
        : this.withMarkdown(page),
    );
  }

  async getPage(pageId: string): Promise<PageResponse> {
    const page = await this.prisma.page.findFirst({
      where: { id: pageId, deleted: null },
    });

    if (!page) {
      throw new NotFoundException({ message: `Page ${pageId} not found` });
    }

    return this.withMarkdown(page);
  }

  /** A page's ancestors, root first — the breadcrumb the page view renders. */
  async getAncestors(pageId: string): Promise<Array<Pick<Page, 'id' | 'title'>>> {
    const ancestors: Array<{ id: string; title: string }> = [];

    let cursor = await this.prisma.page.findFirst({
      where: { id: pageId, deleted: null },
      select: { parentId: true },
    });

    // The reparent guard below keeps the tree acyclic, but a cycle written
    // directly into the database would hang this loop, so the walk is bounded
    // by the number of pages it could legitimately visit.
    const seen = new Set<string>([pageId]);

    while (cursor?.parentId && !seen.has(cursor.parentId)) {
      const parent = await this.prisma.page.findFirst({
        where: { id: cursor.parentId, deleted: null },
        select: { id: true, title: true, parentId: true },
      });

      if (!parent) {
        break;
      }

      seen.add(parent.id);
      ancestors.unshift({ id: parent.id, title: parent.title });
      cursor = { parentId: parent.parentId };
    }

    return ancestors;
  }

  /**
   * Issues that reference this page.
   *
   * Matched on the page's own URL appearing in an issue description, rather
   * than on a join table. A link is how someone actually references a page —
   * they paste it — and asking them to also register the relationship in a
   * second place is how the two drift apart. The page id is a uuid, so the
   * substring cannot collide with prose.
   *
   * The point of showing these is that documentation and work should not be
   * two disconnected worlds: a runbook nobody links to from an issue is one
   * nobody reads when it matters.
   */
  async getBacklinks(
    pageId: string,
    workspaceId: string,
  ): Promise<Array<{ id: string; title: string; number: number; teamId: string }>> {
    const issues = await this.prisma.issue.findMany({
      where: {
        deleted: null,
        team: { workspaceId },
        description: { contains: pageId },
      },
      select: { id: true, title: true, number: true, teamId: true },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });

    return issues;
  }

  // ----------------------------------------------------------------- writing

  async createPage(
    workspaceId: string,
    userId: string,
    pageData: CreatePageDto,
  ): Promise<PageResponse> {
    if (pageData.parentId) {
      await this.assertSameWorkspace(pageData.parentId, workspaceId);
    }

    const last = await this.prisma.page.findFirst({
      where: {
        workspaceId,
        deleted: null,
        parentId: pageData.parentId ?? null,
      },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });

    const page = await this.prisma.page.create({
      data: {
        title: pageData.title,
        description: toStoredBody(pageData) ?? null,
        parentId: pageData.parentId ?? null,
        sortOrder: pageData.sortOrder ?? (last?.sortOrder ?? 0) + 1,
        ...(pageData.entryPolicy ? { entryPolicy: pageData.entryPolicy } : {}),
        workspaceId,
        createdById: userId,
        updatedById: userId,
      },
    });

    await this.recordHistory(page.id, userId, { created: { to: page.title } });
    await this.indexer?.pageChanged(page.id);

    return this.withMarkdown(page);
  }

  async updatePage(
    pageId: string,
    userId: string,
    pageData: UpdatePageDto,
  ): Promise<PageResponse> {
    const current = await this.prisma.page.findFirst({
      where: { id: pageId, deleted: null },
      select: {
        title: true,
        description: true,
        parentId: true,
        entryPolicy: true,
        workspaceId: true,
      },
    });

    if (!current) {
      throw new NotFoundException({ message: `Page ${pageId} not found` });
    }

    if (pageData.parentId !== undefined && pageData.parentId !== null) {
      await this.assertSameWorkspace(pageData.parentId, current.workspaceId);
      await this.assertNotAncestorOfItself(pageId, pageData.parentId);
    }

    const titleChanged =
      pageData.title !== undefined && pageData.title !== current.title;

    // Named one field at a time rather than spread. The global ValidationPipe
    // does not whitelist, so anything else the caller put in the body survives
    // validation and would reach Prisma: `workspaceId` would move the page into
    // another tenant, a nested `entries: { … }` would rewrite asserted facts,
    // and `deleted: null` would undo a delete.
    const page = await this.prisma.page.update({
      where: { id: pageId },
      data: {
        ...(pageData.title !== undefined && { title: pageData.title }),
        ...(toStoredBody(pageData) !== undefined && {
          description: toStoredBody(pageData),
        }),
        ...(pageData.parentId !== undefined && {
          parentId: pageData.parentId,
        }),
        ...(pageData.sortOrder !== undefined && {
          sortOrder: pageData.sortOrder,
        }),
        ...(pageData.entryPolicy !== undefined && {
          entryPolicy: pageData.entryPolicy,
        }),
        updatedById: userId,
      },
    });

    await this.recordHistory(pageId, userId, {
      ...(titleChanged
        ? { title: { from: current.title, to: pageData.title } }
        : {}),
      ...(pageData.parentId !== undefined &&
      pageData.parentId !== current.parentId
        ? { parentId: { from: current.parentId, to: pageData.parentId } }
        : {}),
      ...(pageData.entryPolicy !== undefined &&
      pageData.entryPolicy !== current.entryPolicy
        ? { entryPolicy: { from: current.entryPolicy, to: pageData.entryPolicy } }
        : {}),
      ...(toStoredBody(pageData) !== undefined ? { body: true } : {}),
    },
    // Only when the body actually moved. Storing it on a title-only change
    // would fill the table with copies of an unchanged document and make the
    // history read as though every edit rewrote the page.
    toStoredBody(pageData) !== undefined ? current.description : undefined,
    );
    await this.indexer?.pageChanged(pageId, { titleChanged });

    return this.withMarkdown(page);
  }

  /**
   * Soft-deletes a page and everything under it.
   *
   * Deleting only the named page would leave its children pointing at a row
   * nothing can reach, which reads as data loss in the tree and as orphaned
   * knowledge in retrieval. Entries go with their page for the same reason: an
   * entry whose page is gone has no scope left to be true within.
   */
  async deletePage(pageId: string, userId: string): Promise<PageResponse> {
    const ids = await this.subtreeIds(pageId);
    const deleted = new Date();

    const entries = await this.prisma.pageEntry.findMany({
      where: { pageId: { in: ids }, deleted: null },
      select: { id: true },
    });
    const entryIds = entries.map((entry) => entry.id);

    await this.prisma.$transaction([
      this.prisma.pageEntry.updateMany({
        where: { pageId: { in: ids }, deleted: null },
        data: { deleted },
      }),
      this.prisma.page.updateMany({
        where: { id: { in: ids }, deleted: null },
        data: { deleted, updatedById: userId },
      }),
    ]);

    await this.recordHistory(pageId, userId, {
      deleted: { to: ids.length },
    });
    await this.indexer?.pageDeleted(ids, entryIds);

    return this.getDeletedPage(pageId);
  }

  /**
   * Folds standing entries into the page body and marks them CONSOLIDATED.
   *
   * This is the action that keeps the bank small. The caller supplies the
   * rewritten prose, because deciding how a set of facts reads as a narrative is
   * the judgment being asked for — the server's job is only to make sure the
   * folded entries stop being served separately, or the same fact comes back
   * twice: once from the body and once from the entry it was written into.
   */
  async consolidate(
    pageId: string,
    userId: string,
    input: ConsolidatePageDto,
  ): Promise<PageResponse> {
    const entries = await this.prisma.pageEntry.findMany({
      where: {
        pageId,
        deleted: null,
        status: PageEntryStatusEnum.STANDING,
        ...(input.entryIds?.length ? { id: { in: input.entryIds } } : {}),
      },
      select: { id: true },
    });

    // Folding notes into prose rewrites the body wholesale, which is the one
    // change most likely to want undoing — it is where a person finds out how
    // the narrative reads only after it has replaced what was there.
    const before = await this.prisma.page.findUnique({
      where: { id: pageId },
      select: { description: true },
    });

    const [page] = await this.prisma.$transaction([
      this.prisma.page.update({
        where: { id: pageId },
        data: {
          description: JSON.stringify(
            convertMarkdownToTiptapJson(input.descriptionMarkdown),
          ),
          updatedById: userId,
        },
      }),
      this.prisma.pageEntry.updateMany({
        where: { id: { in: entries.map((entry) => entry.id) } },
        data: { status: PageEntryStatusEnum.CONSOLIDATED },
      }),
    ]);

    await this.recordHistory(
      pageId,
      userId,
      { consolidated: { to: entries.length }, body: true },
      before?.description,
    );
    // The folded entries have to stop being served the moment the body carries
    // them, or the same fact comes back twice — once as narrative and once as
    // the entry it was written from, reading as two confirmations of one thing.
    await this.indexer?.pageChanged(pageId);
    await this.indexer?.entriesChanged(entries.map((entry) => entry.id));

    return this.withMarkdown(page);
  }

  /**
   * What has happened to this page, newest first.
   *
   * The body of each revision comes back as markdown rather than tiptap JSON,
   * for the same reason every other read does: nothing outside the editor
   * should have to parse editor JSON to find out what a page used to say.
   */
  async getHistory(pageId: string): Promise<PageRevision[]> {
    const rows = await this.prisma.pageHistory.findMany({
      where: { pageId, deleted: null },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return rows.map((row) => ({
      id: row.id,
      pageId: row.pageId,
      userId: row.userId,
      createdAt: row.createdAt.toISOString(),
      changes: (row.changes ?? {}) as Record<string, unknown>,
      previousBodyMarkdown: row.previousBody
        ? convertTiptapJsonToMarkdown(row.previousBody)
        : null,
    }));
  }

  /**
   * Puts the body back to what it was before one recorded change.
   *
   * The revert is itself an edit — it records its own history row carrying the
   * body it replaced — so undoing an agent's rewrite is not a hole in the trail
   * and can in turn be undone. A revert that erased its own evidence would make
   * the history lie about what the page has been.
   */
  async revertBody(
    pageId: string,
    historyId: string,
    userId: string,
  ): Promise<PageResponse> {
    const revision = await this.prisma.pageHistory.findFirst({
      where: { id: historyId, pageId, deleted: null },
      select: { previousBody: true },
    });

    if (!revision) {
      throw new NotFoundException({
        message: `No change ${historyId} on page ${pageId}`,
      });
    }

    if (revision.previousBody === null) {
      throw new BadRequestException({
        message:
          'That change did not touch the body, so there is no earlier version ' +
          'of it to go back to.',
      });
    }

    const current = await this.prisma.page.findFirst({
      where: { id: pageId, deleted: null },
      select: { description: true },
    });

    if (!current) {
      throw new NotFoundException({ message: `Page ${pageId} not found` });
    }

    const page = await this.prisma.page.update({
      where: { id: pageId },
      data: { description: revision.previousBody, updatedById: userId },
    });

    await this.recordHistory(
      pageId,
      userId,
      { body: true, revertedTo: { to: historyId } },
      current.description,
    );
    await this.indexer?.pageChanged(pageId);

    return this.withMarkdown(page);
  }

  // --------------------------------------------------------------- internals

  /**
   * Every page in the subtree rooted at `pageId`, including the root.
   *
   * Walked level by level rather than recursively in SQL: the depth of a
   * documentation tree is small, and `seen` makes a cycle written directly into
   * the database terminate rather than spin.
   */
  private async subtreeIds(pageId: string): Promise<string[]> {
    const seen = new Set<string>([pageId]);
    let frontier = [pageId];

    while (frontier.length > 0) {
      const children = await this.prisma.page.findMany({
        where: { parentId: { in: frontier }, deleted: null },
        select: { id: true },
      });

      frontier = children
        .map((child) => child.id)
        .filter((id) => !seen.has(id));

      frontier.forEach((id) => seen.add(id));
    }

    return [...seen];
  }

  /**
   * Refuses a reparent that would make a page its own ancestor.
   *
   * A cycle is not a cosmetic problem: the breadcrumb walk, the subtree delete
   * and the tree render all follow parent pointers, and a loop turns each of
   * them into an infinite one.
   */
  private async assertNotAncestorOfItself(
    pageId: string,
    parentId: string,
  ): Promise<void> {
    if (pageId === parentId) {
      throw new BadRequestException({
        message: 'A page cannot be its own parent',
      });
    }

    const descendants = await this.subtreeIds(pageId);

    if (descendants.includes(parentId)) {
      throw new BadRequestException({
        message: 'A page cannot be moved underneath one of its own children',
      });
    }
  }

  private async assertSameWorkspace(
    parentId: string,
    workspaceId: string,
  ): Promise<void> {
    const parent = await this.prisma.page.findFirst({
      where: { id: parentId, deleted: null, workspaceId },
      select: { id: true },
    });

    if (!parent) {
      throw new NotFoundException({ message: `Page ${parentId} not found` });
    }
  }

  private async getDeletedPage(pageId: string): Promise<PageResponse> {
    const page = await this.prisma.page.findUnique({ where: { id: pageId } });
    return this.withMarkdown(page);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async recordHistory(
    pageId: string,
    userId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    changes: Record<string, any>,
    previousBody?: string | null,
  ): Promise<void> {
    if (Object.keys(changes).length === 0) {
      return;
    }

    await this.prisma.pageHistory.create({
      data: { pageId, userId, changes, previousBody: previousBody ?? null },
    });
  }

  /**
   * The markdown boundary. Bodies are tiptap JSON in the database, but no
   * caller should ever have to parse editor JSON to read a page — the same
   * boundary the issue endpoints and search hits already honour.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private withMarkdown(page: any): PageResponse {
    return {
      ...page,
      descriptionMarkdown: convertTiptapJsonToMarkdown(page.description ?? ''),
    };
  }
}
