import { BadRequestException, Injectable } from '@nestjs/common';

import type { AgentExecutor } from './executor.interface';

/**
 * Where executors are looked up by key.
 *
 * The whole point of this file is that it contains no knowledge of any
 * particular backend. Adapters register themselves; resolution is a map
 * lookup and an ordered fallback. Adding GitHub coding agents later should
 * touch this file zero times.
 */
@Injectable()
export class ExecutorRegistry {
  private readonly executors = new Map<string, AgentExecutor>();

  register(executor: AgentExecutor): void {
    this.executors.set(executor.key, executor);
  }

  list(): AgentExecutor[] {
    return [...this.executors.values()];
  }

  has(key: string): boolean {
    return this.executors.has(key);
  }

  /**
   * The adapter for a key, or a refusal naming what does exist.
   *
   * A typo in an executor key would otherwise surface as a run that nobody
   * ever claims, which looks identical to a runner being offline.
   */
  get(key: string): AgentExecutor {
    const executor = this.executors.get(key);

    if (!executor) {
      throw new BadRequestException({
        message:
          `No executor "${key}". Available: ` +
          `${this.list().map((entry) => entry.key).join(', ') || 'none'}.`,
      });
    }

    return executor;
  }

  /**
   * Which backend should take this run.
   *
   * Ordered: what the request asked for, then what the agent account is bound
   * to, then the workspace default, then the single registered executor if
   * there is only one. The last step matters more than it looks — the common
   * deployment has exactly one backend, and making people configure a choice
   * they do not have is friction for nothing.
   */
  resolve(options: {
    requested?: string | null;
    agentBound?: string | null;
    workspaceDefault?: string | null;
  }): AgentExecutor {
    const candidate =
      options.requested ?? options.agentBound ?? options.workspaceDefault;

    if (candidate) {
      return this.get(candidate);
    }

    const registered = this.list();

    if (registered.length === 0) {
      throw new BadRequestException({
        message:
          'No agent executors are registered in this deployment, so there ' +
          'is nothing to run the work.',
      });
    }

    if (registered.length > 1) {
      throw new BadRequestException({
        message:
          `This deployment has ${registered.length} executors ` +
          `(${registered.map((entry) => entry.key).join(', ')}); name one.`,
      });
    }

    return registered[0];
  }
}
