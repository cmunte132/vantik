/**
 * What becomes of a change to code once the integration has described it:
 * routed to the issues it names, and, once it has landed on the default
 * branch, handed to the pages queue so the knowledge citing its files is
 * checked against the commit it landed as.
 */
import type { CodeChangeEvent } from '@vantikhq/types';

import {
  CODE_LANDED_JOB,
  codeLandedJobOptions,
} from 'modules/pages/pages.interface';

import { ModuleRoutingProcessor } from './module-routing.processor';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

function harness(change: Partial<CodeChangeEvent> | null) {
  const integrations = {
    loadIntegration: jest.fn(async (): Promise<CodeChangeEvent | undefined> =>
      change
        ? {
            externalRepoId: 'repo-1',
            changedPaths: ['apps/server/src/main.ts'],
            issueKeys: [],
            ...change,
          }
        : undefined,
    ),
  };
  const moduleRouting = {
    routeCodeChange: jest.fn(async (): Promise<void> => undefined),
  };
  const pagesQueue = { add: jest.fn(async (): Promise<void> => undefined) };
  const processor = new ModuleRoutingProcessor(
    integrations as never,
    moduleRouting as never,
    pagesQueue as never,
  );

  return { processor, moduleRouting, pagesQueue };
}

const job = {
  data: {
    sourceName: 'github',
    eventBody: {},
    integrationAccountId: 'account-1',
    workspaceId: 'workspace-1',
  },
};

describe('routing a change to code', () => {
  it('[KG-6.1] checks the knowledge a merged change touches though it names no issue, and routes nothing', async () => {
    const t = harness({ mergeSha: SHA, onDefaultBranch: true });

    await t.processor.routeWebhook(job as never);

    const landed = {
      workspaceId: 'workspace-1',
      externalRepoId: 'repo-1',
      sha: SHA,
      changedPaths: ['apps/server/src/main.ts'],
    };

    expect(t.pagesQueue.add).toHaveBeenCalledWith(
      CODE_LANDED_JOB,
      landed,
      codeLandedJobOptions(landed),
    );
    expect(t.moduleRouting.routeCodeChange).not.toHaveBeenCalled();
  });

  it('[KG-6.1] routes a keyed pull request to its issues as before, and checks nothing until it lands', async () => {
    const open = harness({ issueKeys: ['ENG-42'] });

    await open.processor.routeWebhook(job as never);

    expect(open.moduleRouting.routeCodeChange).toHaveBeenCalledWith(
      expect.objectContaining({ issueKeys: ['ENG-42'] }),
      'workspace-1',
    );
    expect(open.pagesQueue.add).not.toHaveBeenCalled();

    const merged = harness({
      issueKeys: ['ENG-42'],
      mergeSha: SHA,
      onDefaultBranch: true,
    });

    await merged.processor.routeWebhook(job as never);

    expect(merged.moduleRouting.routeCodeChange).toHaveBeenCalledTimes(1);
    expect(merged.pagesQueue.add).toHaveBeenCalledTimes(1);
  });

  it('[KG-6.1] checks nothing for a pull request merged into another branch, which lands on the default branch later', async () => {
    const t = harness({
      issueKeys: ['ENG-42'],
      mergeSha: SHA,
      onDefaultBranch: false,
    });

    await t.processor.routeWebhook(job as never);

    expect(t.moduleRouting.routeCodeChange).toHaveBeenCalledTimes(1);
    expect(t.pagesQueue.add).not.toHaveBeenCalled();
  });

  it('[KG-6.1] does nothing for a webhook that is not a change to code', async () => {
    const t = harness(null);

    await t.processor.routeWebhook(job as never);

    expect(t.moduleRouting.routeCodeChange).not.toHaveBeenCalled();
    expect(t.pagesQueue.add).not.toHaveBeenCalled();
  });

  it('[KG-6.1] checks one commit once, however many webhooks report it', () => {
    const landed = {
      workspaceId: 'workspace-1',
      externalRepoId: 'repo-1',
      sha: SHA,
      changedPaths: ['a.ts'],
    };

    // The merged pull request and the push of its merge commit.
    expect(codeLandedJobOptions(landed).jobId).toBe(
      codeLandedJobOptions({ ...landed, changedPaths: ['a.ts', 'b.ts'] }).jobId,
    );
    expect(codeLandedJobOptions(landed).jobId).not.toBe(
      codeLandedJobOptions({ ...landed, sha: 'b'.repeat(40) }).jobId,
    );
  });
});
