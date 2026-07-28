import { Module } from '@nestjs/common';
import { PrismaModule, PrismaService } from 'nestjs-prisma';

import { IntegrationsModule } from 'modules/integrations/integrations.module';
import IssueCommentsService from 'modules/issue-comments/issue-comments.service';
import { IssuesModule } from 'modules/issues/issues.module';
import LinkedIssueService from 'modules/linked-issue/linked-issue.service';
import { ModulesModule } from 'modules/modules/modules.module';

import { WebhookController } from './webhook.controller';
import WebhookService from './webhook.service';

@Module({
  // ModulesModule rather than the routing service on its own: the webhook now
  // enqueues the work, and the queue and its processor are wired up there.
  imports: [PrismaModule, IntegrationsModule, IssuesModule, ModulesModule],
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
