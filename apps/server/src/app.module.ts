import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { MailerModule } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/adapters/handlebars.adapter';
import { PrismaModule } from 'nestjs-prisma';

import config from 'common/configs/config';
import { BuildStampInterceptor } from 'common/interceptors/build-stamp.interceptor';
import { ErrorReportingInterceptor } from 'common/interceptors/error-reporting.interceptor';

import { ActionModule } from 'modules/action/action.module';
import { AgentSkillModule } from 'modules/agent-skill/agent-skill.module';
import { AIRequestsModule } from 'modules/ai-requests/ai-requests.module';
import { ALSModule } from 'modules/als/als.module';
import { AttachmentModule } from 'modules/attachments/attachments.module';
import { AgentScopeGuard } from 'modules/auth/agent-scope.guard';
import { AuthModule } from 'modules/auth/auth.module';
import { BullConfigModule } from 'modules/bull/bull.module';
import { CachceModule } from 'modules/cache/cache.module';
import { CapabilitiesModule } from 'modules/capabilities/capabilities.module';
import { ChecklistItemsModule } from 'modules/checklist-items/checklist-items.module';
import { ClientConfigModule } from 'modules/client-config/client-config.module';
import { CompanyModule } from 'modules/company/company.modules';
import { ConversationModule } from 'modules/conversation/conversation.module';
import { ConversationHistoryModule } from 'modules/conversation-history/conversation-history.module';
import { CyclesModule } from 'modules/cycles/cycles.module';
import { HealthModule } from 'modules/health/health.module';
import { IntegrationAccountModule } from 'modules/integration-account/integration-account.module';
import { IntegrationDefinitionModule } from 'modules/integration-definition/integration-definition.module';
import { IntegrationsModule } from 'modules/integrations/integrations.module';
import { IssueCommentsModule } from 'modules/issue-comments/issue-comments.module';
import { IssueHistoryModule } from 'modules/issue-history/issue-history.module';
import { IssueRelationModule } from 'modules/issue-relation/issue-relation.module';
import { IssuesModule } from 'modules/issues/issues.module';
import { LabelsModule } from 'modules/labels/labels.module';
import { LinkedIssueModule } from 'modules/linked-issue/linked-issue.module';
import { LocalRepoModule } from 'modules/local-repo/local-repo.module';
import { McpModule } from 'modules/mcp/mcp.module';
import { ModulesModule } from 'modules/modules/modules.module';
import { NotificationsModule } from 'modules/notifications/notifications.module';
import { OAuthCallbackModule } from 'modules/oauth-callback/oauth-callback.module';
import { PagesModule } from 'modules/pages/pages.module';
import { PeopleModule } from 'modules/people/people.module';
import { ProductsModule } from 'modules/products/products.module';
import { ProjectsModule } from 'modules/projects/projects.module';
import { PromptsModule } from 'modules/prompts/prompts.module';
import { ReplicationModule } from 'modules/replication/replication.module';
import { SearchModule } from 'modules/search/search.module';
import { SupportModule } from 'modules/support/support.module';
import { SyncModule } from 'modules/sync/sync.module';
import { SyncActionsModule } from 'modules/sync-actions/sync-actions.module';
import { TeamsModule } from 'modules/teams/teams.module';
import { TemplatesModule } from 'modules/templates/templates.module';
import { TriggerdevModule } from 'modules/triggerdev/triggerdev.module';
import { UsersModule } from 'modules/users/users.module';
import { ViewsModule } from 'modules/views/views.module';
import { WebhookModule } from 'modules/webhook/webhook.module';
import { WebhookSubscriptionModule } from 'modules/webhook-subscription/webhook-subscription.module';
import { WorkflowsModule } from 'modules/workflows/workflows.module';
import { WorkspacesModule } from 'modules/workspaces/workspaces.module';

import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    CacheModule.register({
      isGlobal: true,
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 10,
      },
    ]),
    ConfigModule.forRoot({ isGlobal: true, load: [config] }),
    ConfigModule.forRoot({ envFilePath: '.env' }),
    PrismaModule.forRoot({
      isGlobal: true,
    }),

    MailerModule.forRoot({
      transport: {
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT),
        secure: process.env.SMTP_USE_SLS === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASSWORD,
        },
      },
      defaults: {
        from: `${process.env.SMTP_DEFAULT_FROM}`,
      },
      template: {
        dir: `${process.cwd()}/templates`,
        adapter: new HandlebarsAdapter(),
        options: {
          strict: true,
        },
      },
    }),

    AuthModule.forRoot(),
    ALSModule,
    HealthModule,
    UsersModule,
    WorkspacesModule,
    TeamsModule,
    LabelsModule,
    TemplatesModule,
    WorkflowsModule,
    IssuesModule,
    IssueCommentsModule,
    ChecklistItemsModule,
    IssueHistoryModule,
    LinkedIssueModule,
    IssueRelationModule,
    NotificationsModule,
    SearchModule,
    McpModule,
    AgentSkillModule,
    AttachmentModule,
    ViewsModule,
    TriggerdevModule,
    ActionModule,
    AIRequestsModule,
    ProjectsModule,
    ProductsModule,
    ModulesModule,
    CapabilitiesModule,
    PagesModule,
    CyclesModule,
    WebhookSubscriptionModule,

    WebhookModule,

    ReplicationModule,
    SyncActionsModule,
    SyncModule,

    IntegrationDefinitionModule,
    PromptsModule,
    OAuthCallbackModule,
    IntegrationAccountModule,
    IntegrationsModule,
    LocalRepoModule,

    BullConfigModule,

    ConversationModule,
    ConversationHistoryModule,

    CachceModule,
    ClientConfigModule,

    CompanyModule,
    PeopleModule,
    SupportModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,

    // Registered globally so an agent is held to its scopes on every route,
    // rather than only on the ones somebody remembered to decorate. It
    // resolves the caller from the token itself, so running ahead of each
    // route's AuthGuard costs it nothing.
    { provide: APP_GUARD, useClass: AgentScopeGuard },

    // Records 5xx exceptions on the active span before they reach the
    // exception filters, which own the response.
    { provide: APP_INTERCEPTOR, useClass: ErrorReportingInterceptor },

    // Advertises this image's build on every response, so version skew between
    // the two images is visible without asking for it.
    { provide: APP_INTERCEPTOR, useClass: BuildStampInterceptor },
  ],
})
export class AppModule {}
