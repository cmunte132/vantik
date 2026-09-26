import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { PrismaService } from 'nestjs-prisma';

import { IntegrationsService } from 'modules/integrations/integrations.service';
import { LoggerService } from 'modules/logger/logger.service';

import { ensureIntegrationBot } from './integration-bot';
import {
  DISPATCH_JOB,
  INTEGRATION_EVENTS_QUEUE,
  type IntegrationEventJob,
} from './integration-events.interface';

/**
 * Runs one event through one connected account's plugin, in this process.
 *
 * The plugin is handed the account it belongs to — its settings carry the
 * team mappings — and writes as the integration's bot member. It is never
 * handed a token: `ctx.vendor.fetch` resolves one per call.
 */
@Processor(INTEGRATION_EVENTS_QUEUE)
export class IntegrationEventsProcessor {
  private readonly logger = new LoggerService(IntegrationEventsProcessor.name);

  constructor(
    private prisma: PrismaService,
    private integrations: IntegrationsService,
  ) {}

  @Process(DISPATCH_JOB)
  async dispatch(job: Job<IntegrationEventJob>) {
    const { slug, workspaceId, integrationAccountId, event, payload } =
      job.data;

    const integrationAccount = await this.prisma.integrationAccount.findFirst({
      where: { id: integrationAccountId, workspaceId, deleted: null },
      select: {
        id: true,
        accountId: true,
        settings: true,
        workspaceId: true,
        integrationDefinition: {
          select: { id: true, slug: true, name: true, icon: true },
        },
        workspace: { select: { id: true, slug: true } },
      },
    });

    if (!integrationAccount) {
      return { message: `Account ${integrationAccountId} was disconnected` };
    }

    try {
      const botId = await ensureIntegrationBot(
        this.prisma,
        workspaceId,
        integrationAccount.integrationDefinition,
      );

      return await this.integrations.loadIntegration(slug, {
        ...payload,
        event,
        workspaceId,
        integrationAccountId,
        integrationAccount,
        userId: botId,
      });
    } catch (error) {
      this.logger.error({
        message: `${slug} failed on ${event} for account ${integrationAccountId}: ${error}`,
        where: 'IntegrationEventsProcessor.dispatch',
        error: error instanceof Error ? error : undefined,
      });
      throw error;
    }
  }
}
