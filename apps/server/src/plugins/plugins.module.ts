import { Module } from '@nestjs/common';
import { PrismaModule, PrismaService } from 'nestjs-prisma';

import AIRequestsService from 'modules/ai-requests/ai-requests.services';
import { AttachmentModule } from 'modules/attachments/attachments.module';
import { IssueCommentsModule } from 'modules/issue-comments/issue-comments.module';
import { IssuesModule } from 'modules/issues/issues.module';
import { LinkedIssueModule } from 'modules/linked-issue/linked-issue.module';

import { PluginContextFactory } from './plugin-context.factory';

/**
 * The host side of the plugin contract.
 *
 * Imports the modules whose services back the capabilities rather than
 * providing those services again: a plugin creating an issue must take the same
 * path a person does, so the queues, the notification delivery and the history
 * all see it.
 */
@Module({
  imports: [
    PrismaModule,
    IssuesModule,
    IssueCommentsModule,
    LinkedIssueModule,
    AttachmentModule,
  ],
  providers: [PluginContextFactory, PrismaService, AIRequestsService],
  exports: [PluginContextFactory],
})
export class PluginsModule {}
