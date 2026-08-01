import { Module } from '@nestjs/common';
import { PrismaModule, PrismaService } from 'nestjs-prisma';

import { ActionEventModule } from 'modules/action-event/action-event.module';
import { IntegrationsModule } from 'modules/integrations/integrations.module';
import IssueCommentsService from 'modules/issue-comments/issue-comments.service';
import { IssuesModule } from 'modules/issues/issues.module';
import LinkedIssueService from 'modules/linked-issue/linked-issue.service';
import { ModulesModule } from 'modules/modules/modules.module';
import { NotificationsModule } from 'modules/notifications/notifications.module';

import { WebhookController } from './webhook.controller';
import WebhookService from './webhook.service';

@Module({
  // ModulesModule rather than the routing service on its own: the webhook now
  // enqueues the work, and the queue and its processor are wired up there.
  // NotificationsModule because IssueCommentsService is provided here rather
  // than imported, and commenting notifies.
  // ActionEventModule for the actions queue a source webhook dispatches onto.
  imports: [
    PrismaModule,
    IntegrationsModule,
    IssuesModule,
    ModulesModule,
    NotificationsModule,
    ActionEventModule,
  ],
  controllers: [WebhookController],
  providers: [
    PrismaService,
    WebhookService,
    IssueCommentsService,
    LinkedIssueService,
  ],
  exports: [],
})
export class WebhookModule {}
