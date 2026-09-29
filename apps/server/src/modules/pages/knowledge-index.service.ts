import { Injectable } from '@nestjs/common';
import { PageEntryStatusEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { onLivePageOrLoose } from 'common/page-entry-where';

import { LoggerService } from 'modules/logger/logger.service';
import {
  ENTRY_INDEX_INCLUDE,
  INDEXED_STATUSES,
} from 'modules/vector/vector.interface';
import { VectorService } from 'modules/vector/vector.service';

/**
 * Keeps the search index in step with postgres.
 *
 * Every method here swallows its errors on purpose. The index is a cache and
 * postgres is the truth, so a typesense outage must degrade search rather than
 * stop a person saving a page — and the stale-collection rebuild in
 * `VectorService` is what repairs whatever was missed. The one thing it does
 * *not* swallow is the removal of a retracted fact, which is why deletes are
 * attempted for both shapes of document and logged loudly when they fail: a
 * fact that stays searchable after being rejected is the failure that costs
 * the bank its trust.
 */
@Injectable()
export default class KnowledgeIndexService {
  private readonly logger = new LoggerService('KnowledgeIndexService');

  constructor(
    private prisma: PrismaService,
    private vectorService: VectorService,
  ) {}

  /**
   * `titleChanged` is what decides whether the page's entries are rewritten
   * too. Only the title reaches an entry's document, and a body edit is
   * autosaved once a second while somebody types — so re-embedding every
   * standing entry on every save would spend a page's worth of embedding work
   * per keystroke burst to write back values that did not move.
   */
  async pageChanged(
    pageId: string,
    { titleChanged = false }: { titleChanged?: boolean } = {},
  ): Promise<void> {
    try {
      const page = await this.prisma.page.findUnique({ where: { id: pageId } });

      if (!page || page.deleted) {
        await this.vectorService.deleteKnowledgeDocument(`page:${pageId}`);
        return;
      }

      await this.vectorService.indexPage(page);

      // A page's title is part of every one of its entries' documents, so a
      // rename that only touched the page row would leave entries advertising
      // the old name in search results.
      if (titleChanged) {
        await this.reindexEntries(pageId);
      }
    } catch (error) {
      this.log('pageChanged', pageId, error);
    }
  }

  async entryChanged(entryId: string): Promise<void> {
    try {
      const entry = await this.prisma.pageEntry.findUnique({
        where: { id: entryId },
        include: ENTRY_INDEX_INCLUDE,
      });

      // Standing, consolidated and proposed entries are indexed; everything
      // else is removed. Only the first two are ever *served* — the read
      // filter defaults to them, a consolidated one as the evidence for its
      // page, and only the near-match query widens past it — but a proposed
      // entry has to be findable by that query or the duplicate check cannot
      // see the claims most likely to be duplicates: the ones still sitting
      // in the inbox.
      if (
        !entry ||
        entry.deleted ||
        !INDEXED_STATUSES.includes(entry.status as PageEntryStatusEnum)
      ) {
        await this.vectorService.deleteKnowledgeDocument(`entry:${entryId}`);
        return;
      }

      await this.vectorService.indexEntry(entry);
    } catch (error) {
      this.log('entryChanged', entryId, error);
    }
  }

  /** Applies one index decision per entry, for the bulk triage path. */
  async entriesChanged(entryIds: string[]): Promise<void> {
    await Promise.all(entryIds.map((id) => this.entryChanged(id)));
  }

  /**
   * Indexes every consolidated entry, on a page not deleted, that the index
   * does not hold, and says how many. Entries consolidated before a
   * consolidated entry was served were taken out of the index then, so they
   * could not be found as their page's evidence; this puts them back, and
   * any other the index lost. One export of ids when there is nothing to do.
   */
  async indexMissingConsolidated(): Promise<number> {
    try {
      const entries = await this.prisma.pageEntry.findMany({
        where: {
          deleted: null,
          status: PageEntryStatusEnum.CONSOLIDATED,
          ...onLivePageOrLoose(),
        },
        select: { id: true },
      });

      if (entries.length === 0) {
        return 0;
      }

      const indexed = await this.vectorService.indexedEntryIds(
        PageEntryStatusEnum.CONSOLIDATED,
      );
      const missing = entries
        .map((entry) => entry.id)
        .filter((id) => !indexed.has(id));

      for (const id of missing) {
        await this.entryChanged(id);
      }

      if (missing.length) {
        this.logger.info({
          message: `Indexed ${missing.length} consolidated entr${
            missing.length === 1 ? 'y' : 'ies'
          } the index did not hold`,
          where: 'KnowledgeIndexService.indexMissingConsolidated',
        });
      }

      return missing.length;
    } catch (error) {
      this.log('indexMissingConsolidated', 'consolidated entries', error);

      return 0;
    }
  }

  async pageDeleted(pageIds: string[], entryIds: string[]): Promise<void> {
    try {
      await Promise.all([
        ...pageIds.map((id) =>
          this.vectorService.deleteKnowledgeDocument(`page:${id}`),
        ),
        ...entryIds.map((id) =>
          this.vectorService.deleteKnowledgeDocument(`entry:${id}`),
        ),
      ]);
    } catch (error) {
      this.log('pageDeleted', pageIds.join(','), error);
    }
  }

  private async reindexEntries(pageId: string): Promise<void> {
    const entries = await this.prisma.pageEntry.findMany({
      where: {
        pageId,
        deleted: null,
        status: { in: INDEXED_STATUSES },
      },
      include: ENTRY_INDEX_INCLUDE,
    });

    for (const entry of entries) {
      await this.vectorService.indexEntry(entry);
    }
  }

  private log(where: string, id: string, error: Error): void {
    this.logger.error({
      message: `Knowledge index update failed for ${id}: ${error.message}`,
      where: `KnowledgeIndexService.${where}`,
      error,
    });
  }
}
