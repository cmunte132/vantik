import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { ActionTypesEnum, EventBody, EventHeaders } from '@vantikhq/types';
import { JobOptions, Queue } from 'bull';
import { PrismaService } from 'nestjs-prisma';

import { IntegrationsService } from 'modules/integrations/integrations.service';
import { LoggerService } from 'modules/logger/logger.service';

import {
  DISPATCH_JOB,
  INTEGRATION_EVENTS_QUEUE,
  type IntegrationEventJob,
  type RecordChange,
} from './integration-events.interface';

/**
 * Hands record changes and webhooks to the integrations a workspace connected.
 *
 * Connecting an integration is the whole configuration. What each one reacts
 * to is declared by its plugin — `onRecord` for changes to issues, comments and
 * links, `webhooks` for its vendor's own deliveries — and every connected
 * workspace account whose plugin declares it gets the event. Before this, a
 * connected GitHub did nothing until somebody also deployed a GitHub *Action*
 * from the CLI, and the two lived in different tables that nothing kept in
 * step.
 */
@Injectable()
export class IntegrationEventsService {
  private readonly logger = new LoggerService(IntegrationEventsService.name);

  constructor(
    private prisma: PrismaService,
    private integrations: IntegrationsService,
    @InjectQueue(INTEGRATION_EVENTS_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * A row changed. Each server replica has its own replication slot, so every
   * replica calls this for the same change; the job id is what makes that one
   * dispatch rather than one per replica.
   */
  async recordChanged(change: RecordChange) {
    const event = eventOf(change.tag);

    if (!event || !change.workspaceId) {
      return;
    }

    const accounts = await this.connectedAccounts(change.workspaceId);

    for (const account of accounts) {
      const spec = await this.integrations.pluginSpecOf(account.slug);
      const subscribed = spec?.onRecord?.some(
        (trigger) =>
          trigger.event === event && trigger.model === change.modelName,
      );

      if (!subscribed) {
        continue;
      }

      await this.enqueue(
        {
          slug: account.slug,
          workspaceId: change.workspaceId,
          integrationAccountId: account.id,
          event,
          payload: {
            type: change.modelName,
            modelId: change.modelId,
            changedData:
              event === ActionTypesEnum.ON_UPDATE ? change.changedData : {},
          },
        },
        {
          jobId: `${account.id}:${change.modelName}:${change.modelId}:${change.lsn}`,
        },
      );
    }
  }

  /** A vendor's webhook, already matched to one connected account. */
  async webhookReceived(delivery: {
    slug: string;
    workspaceId: string;
    integrationAccountId: string;
    eventBody: EventBody;
    eventHeaders: EventHeaders;
  }) {
    const spec = await this.integrations.pluginSpecOf(delivery.slug);

    if (!spec?.webhooks) {
      return;
    }

    await this.enqueue({
      slug: delivery.slug,
      workspaceId: delivery.workspaceId,
      integrationAccountId: delivery.integrationAccountId,
      event: ActionTypesEnum.SOURCE_WEBHOOK,
      payload: {
        eventBody: delivery.eventBody,
        eventHeaders: delivery.eventHeaders,
      },
    });
  }

  /**
   * Workspace accounts only. A personal account is somebody's own identity on
   * the vendor, used to write as them; it is never who reacts to an event.
   */
  private async connectedAccounts(workspaceId: string) {
    const accounts = await this.prisma.integrationAccount.findMany({
      where: { workspaceId, personal: false, deleted: null },
      select: { id: true, integrationDefinition: { select: { slug: true } } },
    });

    return accounts.map((account) => ({
      id: account.id,
      slug: account.integrationDefinition.slug,
    }));
  }

  private async enqueue(job: IntegrationEventJob, options: JobOptions = {}) {
    try {
      await this.queue.add(DISPATCH_JOB, job, {
        // One attempt. Creating a GitHub issue or an issue from an email is
        // not safe to repeat, and a failure is kept below where it can be
        // read rather than retried into a duplicate.
        attempts: 1,
        // Kept for an hour so the job id still dedupes the other replicas'
        // copies of the same change, and bounded so the set cannot grow.
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: 100,
        ...options,
      });
    } catch (error) {
      // Creating an issue must not fail because Redis blinked; the event is
      // lost, and said so.
      this.logger.error({
        message: `Could not queue ${job.event} for ${job.slug}: ${error}`,
        where: 'IntegrationEventsService.enqueue',
        error: error instanceof Error ? error : undefined,
      });
    }
  }
}

/** A soft delete arrives as `delete`; no plugin reacts to one. */
function eventOf(tag: string) {
  switch (tag) {
    case 'insert':
      return ActionTypesEnum.ON_CREATE;

    case 'update':
      return ActionTypesEnum.ON_UPDATE;

    default:
      return null;
  }
}
