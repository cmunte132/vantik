import type { AgentRun } from '@prisma/client';
import { Injectable, OnModuleInit } from '@nestjs/common';

import { ExecutorRegistry } from './executor.registry';
import type { AgentExecutor, ExecutorAvailability } from './executor.interface';

export const BYO_EXECUTOR_KEY = 'byo';

/**
 * The bring-your-own runner: a process the user runs on their own machine or
 * in their own CI, holding their own model credentials and repo access.
 *
 * Queue-based, and that is what makes it the adapter with almost nothing in
 * it. Creating the QUEUED row *is* the dispatch — a runner long-polls for work
 * it is eligible for and claims it when it is ready. There is nothing to push
 * to, no endpoint to call, and nothing that can fail here.
 *
 * That property is deliberate and worth protecting: it means BYO works on a
 * stock install with no background worker at all. trigger.dev is optional in
 * every deployment this repo ships and absent from the compose file, so an
 * executor that needed it would silently drop every run.
 *
 * It is also always available. It needs no server-side credentials and no
 * sandbox runtime — the runner holds everything, and the server never sees it.
 */
@Injectable()
export class ByoExecutor implements AgentExecutor, OnModuleInit {
  readonly key = BYO_EXECUTOR_KEY;
  readonly label = 'Your own runner';

  constructor(private registry: ExecutorRegistry) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async availability(): Promise<ExecutorAvailability> {
    // Whether a runner is actually *running* is deliberately not checked. A
    // queued run waiting for a laptop to wake up is a normal state, not an
    // error, and refusing delegation because nothing is polling right now
    // would break the "delegate now, start the runner later" case entirely.
    return { available: true };
  }

  async dispatch(_run: AgentRun): Promise<void> {
    // Nothing to do. The row is the queue.
  }

  async cancel(_run: AgentRun): Promise<void> {
    // Nothing to do. The run is already terminal in the database, and the
    // runner learns it must stop from its next heartbeat — which is refused
    // for a terminal run precisely so this case needs no channel back.
  }
}
