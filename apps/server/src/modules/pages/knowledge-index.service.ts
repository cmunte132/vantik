import { Injectable } from '@nestjs/common';
import { PageEntryStatusEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { LoggerService } from 'modules/logger/logger.service';
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

  async pageChanged(pageId: string): Promise<void> {
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
      await this.reindexEntries(pageId);
    } catch (error) {
      this.log('pageChanged', pageId, error);
    }
  }

  async entryChanged(entryId: string): Promise<void> {
    try {
      const entry = await this.prisma.pageEntry.findUnique({
        where: { id: entryId },
        include: { page: { select: { title: true, workspaceId: true } } },
      });

      // Only standing entries are served, so anything else is removed from the
      // index rather than indexed with a status filter standing between it and
      // a caller — one filter mistake would otherwise expose the whole inbox.
      if (
        !entry ||
        entry.deleted ||
        entry.status !== PageEntryStatusEnum.STANDING
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
        status: PageEntryStatusEnum.STANDING,
      },
      include: { page: { select: { title: true, workspaceId: true } } },
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
