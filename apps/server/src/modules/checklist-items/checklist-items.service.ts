import { Injectable } from '@nestjs/common';
import {
  ChecklistItem,
  ChecklistItemRequestParamsDto,
  CreateChecklistItemDto,
  CreateChecklistItemRequestParamsDto,
  UpdateChecklistItemDto,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

@Injectable()
export default class ChecklistItemsService {
  constructor(private prisma: PrismaService) {}

  async getChecklistItems(
    issueParams: CreateChecklistItemRequestParamsDto,
  ): Promise<ChecklistItem[]> {
    return this.prisma.checklistItem.findMany({
      where: { issueId: issueParams.issueId, deleted: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createChecklistItem(
    issueParams: CreateChecklistItemRequestParamsDto,
    userId: string,
    itemData: CreateChecklistItemDto,
  ): Promise<ChecklistItem> {
    // New items land at the end of the list. Reading max+1 keeps the ordering
    // dense enough without a client-supplied position.
    const last = await this.prisma.checklistItem.findFirst({
      where: { issueId: issueParams.issueId, deleted: null },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });

    const completed = itemData.completed ?? false;

    return this.prisma.checklistItem.create({
      data: {
        body: itemData.body,
        completed,
        sortOrder: itemData.sortOrder ?? (last?.sortOrder ?? 0) + 1,
        issueId: issueParams.issueId,
        createdById: userId,
        updatedById: userId,
        // A criterion created already-ticked still records who and when.
        ...(completed && { completedAt: new Date(), completedById: userId }),
      },
    });
  }

  async updateChecklistItem(
    checklistItemParams: ChecklistItemRequestParamsDto,
    userId: string,
    itemData: UpdateChecklistItemDto,
  ): Promise<ChecklistItem> {
    const { completed, ...rest } = itemData;

    // Only touch completion provenance when the checked state actually
    // changes, so a plain body edit does not overwrite who ticked the item.
    let completionData = {};
    if (completed !== undefined) {
      const current = await this.prisma.checklistItem.findUnique({
        where: { id: checklistItemParams.checklistItemId },
        select: { completed: true },
      });

      if (current && current.completed !== completed) {
        completionData = completed
          ? { completedAt: new Date(), completedById: userId }
          : { completedAt: null, completedById: null };
      }
    }

    // Named one by one rather than spread. The global ValidationPipe does not
    // whitelist, so anything else the caller put in the body survives validation
    // and would reach Prisma: `issueId` would move the item onto an issue in
    // another workspace (the guard only proves the item's *current* issue is the
    // caller's), a nested `issue: { update: … }` would edit the parent issue, and
    // `deleted: null` would undo a delete.
    return this.prisma.checklistItem.update({
      where: { id: checklistItemParams.checklistItemId },
      data: {
        ...(rest.body !== undefined && { body: rest.body }),
        ...(rest.sortOrder !== undefined && { sortOrder: rest.sortOrder }),
        ...(completed !== undefined && { completed }),
        ...completionData,
        updatedById: userId,
      },
    });
  }

  async deleteChecklistItem(
    checklistItemParams: ChecklistItemRequestParamsDto,
    userId: string,
  ): Promise<ChecklistItem> {
    // Soft delete: replication ignores hard deletes and drives client removal
    // off the `deleted` timestamp instead.
    return this.prisma.checklistItem.update({
      where: { id: checklistItemParams.checklistItemId },
      data: { deleted: new Date(), updatedById: userId },
    });
  }
}
