import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';

import { IntegrationsService } from 'modules/integrations/integrations.service';
import { LoggerService } from 'modules/logger/logger.service';

import {
  ACTIONS_QUEUE,
  RUN_ACTION_JOB,
  type RunActionJob,
} from './actions.interface';

/**
 * Runs an action, in this process, against the code already in the repo.
 *
 * `loadIntegration` imports `apps/server/src/integrations/<slug>` and calls its
 * default export. That is the same call ten other places in the server already
 * make, and it replaces fetching a bundle over HTTP and evaluating it with
 * `new Function` — which is what `trigger/action-run.ts` did, in a worker that
 * is not deployed.
 *
 * **What this stage does not do.** The behaviour half of each vendor still
 * lives under `actions/<name>` and has not moved, so an integration asked for
 * `ON_CREATE` today answers that it does not recognise the event. That is not a
 * regression — nothing ran before — and it is the seam stage 3 fills in, vendor
 * by vendor. What is finished here is the dispatch: the automation path no
 * longer reaches for trigger.dev at all.
 */
@Processor(ACTIONS_QUEUE)
export class ActionsProcessor {
  private readonly logger: LoggerService = new LoggerService(
    'ActionsProcessor',
  );

  constructor(private integrationsService: IntegrationsService) {}

  @Process(RUN_ACTION_JOB)
  async handleRunAction(job: Job<RunActionJob>) {
    const { slug, event, payload, actionId, workspaceId } = job.data;

    try {
      return await this.integrationsService.loadIntegration(slug, {
        event,
        workspaceId,
        ...payload,
      });
    } catch (error) {
      // Rethrown so Bull records the failure and keeps the job where somebody
      // can find it. The previous arrangement let this fall through to the
      // process-wide unhandledRejection handler as a bare "Connection error"
      // naming nothing.
      this.logger.error({
        message: `Action ${actionId} (${slug}) failed on ${event}: ${error}`,
        where: 'ActionsProcessor.handleRunAction',
        error: error instanceof Error ? error : undefined,
      });
      throw error;
    }
  }
}
