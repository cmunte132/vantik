/**
 * The schedule behind the decay pass.
 *
 * `runDecay` is tested in page-entries.service.spec.ts — what is tested here is
 * that something actually calls it, on a schedule that is singular across
 * replicas and can be changed or turned off without leaving a stale one behind.
 * A dormant decay pass is the failure this file exists to catch: the arithmetic
 * can be perfect and the bank still grows without bound.
 */
import { Queue } from 'bull';

import EntryCitationsService from './entry-citations.service';
import PageRefreshService, {
  type RefreshOutcome,
} from './generated/page-refresh.service';
import PageEntriesService from './page-entries.service';
import {
  DECAY_JOB,
  DECAY_JOB_ID,
  GAP_ISSUES_JOB,
  GAP_ISSUES_JOB_ID,
  PAGE_REFRESH_JOB,
  PAGE_REFRESH_JOB_ID,
  RECHECK_ENTRY_JOB,
  recheckEntryJobOptions,
  RECOMPUTE_MODULES_GRACE_MS,
  RECOMPUTE_MODULES_JOB,
  RECOMPUTE_MODULES_WINDOW_MS,
  recomputeModulesJobOptions,
  REFRESH_PAGE_JOB,
  refreshPageJobOptions,
  RETRY_CITATIONS_ATTEMPTS,
  RETRY_CITATIONS_BACKOFF_MS,
  RETRY_CITATIONS_JOB,
  retryCitationsJobOptions,
  RUN_FINDINGS_JOB,
  runFindingsJobOptions,
} from './pages.interface';
import {
  EntryModulesScheduler,
  KnowledgeGapsScheduler,
  PageRefreshScheduler,
  PagesProcessor,
  PagesScheduler,
} from './pages.processor';
import KnowledgeTriageService from './triage/knowledge-triage.service';
import KnowledgeConventionsService from './upkeep/knowledge-conventions.service';
import KnowledgeGapsService from './upkeep/knowledge-gaps.service';
import KnowledgeUpkeepService from './upkeep/knowledge-upkeep.service';

function buildQueue(existing: Array<{ name: string; key: string }> = []) {
  return {
    getRepeatableJobs: jest.fn(() => Promise.resolve(existing)),
    removeRepeatableByKey: jest.fn(() => Promise.resolve()),
    add: jest.fn(() => Promise.resolve()),
  } as unknown as Queue & {
    getRepeatableJobs: jest.Mock;
    removeRepeatableByKey: jest.Mock;
    add: jest.Mock;
  };
}

describe('PagesScheduler', () => {
  it('registers the decay pass under a fixed id', async () => {
    const queue = buildQueue();

    await new PagesScheduler(queue).onModuleInit();

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, , options] = queue.add.mock.calls[0];
    expect(name).toBe(DECAY_JOB);
    expect(options.repeat.cron).toBeTruthy();
    // Every replica registers at boot; without a stable id each adds its own
    // copy and the pass runs once per replica per night.
    expect(options.jobId).toBe(DECAY_JOB_ID);
  });

  it('clears the previous schedule before registering, so the cron is changeable', async () => {
    const queue = buildQueue([
      { name: DECAY_JOB, key: 'old-key' },
      { name: 'somethingElse', key: 'other-key' },
    ]);

    await new PagesScheduler(queue).onModuleInit();

    // Bull keys a repeatable job by its cron expression, so changing
    // PAGE_DECAY_CRON without this leaves the old schedule registered too.
    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('old-key');
    expect(queue.removeRepeatableByKey).not.toHaveBeenCalledWith('other-key');
  });

  it('does not stop the server coming up when the queue is unreachable', async () => {
    const queue = buildQueue();
    queue.getRepeatableJobs.mockRejectedValue(new Error('redis is down'));

    // Matching the vector collections: setup that fails degrades the feature
    // rather than taking the deployment with it.
    await expect(
      new PagesScheduler(queue).onModuleInit(),
    ).resolves.toBeUndefined();
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('PagesProcessor', () => {
  it('runs decay across every workspace', async () => {
    const runDecay = jest.fn(() =>
      Promise.resolve({ expiredProposed: 3, archivedStanding: 1 }),
    );
    const service = { runDecay } as unknown as PageEntriesService;

    await new PagesProcessor(
      service,
      {} as EntryCitationsService,
      {} as KnowledgeTriageService,
      {
        proposeUnused: async () => 0,
        openOwedIssues: async () => 0,
      } as unknown as KnowledgeUpkeepService,
      {} as KnowledgeConventionsService,
      {} as KnowledgeGapsService,
      {} as PageRefreshService,
    ).handleDecay();

    // Unscoped deliberately: the windows are a property of the deployment, not
    // of any one workspace.
    expect(runDecay).toHaveBeenCalledWith();
  });
});

describe('re-resolving entry modules', () => {
  it('[KG-1.2] queues one pass over every workspace at boot', async () => {
    const queue = buildQueue();

    await new EntryModulesScheduler(queue).onModuleInit();

    expect(queue.add).toHaveBeenCalledWith(
      RECOMPUTE_MODULES_JOB,
      {},
      expect.objectContaining({
        jobId: expect.stringMatching(`^${RECOMPUTE_MODULES_JOB}:all:`),
      }),
    );
  });

  it('[KG-1.2] folds requests in one window into one pass that starts after the window closes', () => {
    const W = RECOMPUTE_MODULES_WINDOW_MS;
    const start = 1_000 * W;

    const first = recomputeModulesJobOptions('ws-1', start + 1);
    const last = recomputeModulesJobOptions('ws-1', start + W - 1);

    // Same window, same id: Bull ignores the second add.
    expect(last.jobId).toBe(first.jobId);
    // Neither starts before the window has closed, plus a grace for servers
    // whose clocks disagree, so no request in it can arrive after its pass
    // has already read the repositories.
    const closes = start + W + RECOMPUTE_MODULES_GRACE_MS;
    expect(start + 1 + (first.delay as number)).toBe(closes);
    expect(start + W - 1 + (last.delay as number)).toBe(closes);
  });

  it('[KG-1.2] gives a later request, or another workspace, a pass of its own', () => {
    const W = RECOMPUTE_MODULES_WINDOW_MS;
    const start = 1_000 * W;
    const pass = recomputeModulesJobOptions('ws-1', start).jobId;

    // Made while the first pass may be running: never swallowed by it.
    expect(recomputeModulesJobOptions('ws-1', start + W).jobId).not.toBe(pass);
    expect(recomputeModulesJobOptions('ws-2', start).jobId).not.toBe(pass);
    expect(recomputeModulesJobOptions(undefined, start).jobId).not.toBe(pass);
  });

  it('[KG-1.2] runs the pass for the workspace a job names, or for all of them', async () => {
    const recomputeModules = jest.fn(async () => ({ changed: 2 }));
    const processor = new PagesProcessor(
      { recomputeModules } as unknown as PageEntriesService,
      {} as EntryCitationsService,
      {} as KnowledgeTriageService,
      {} as KnowledgeUpkeepService,
      {} as KnowledgeConventionsService,
      {} as KnowledgeGapsService,
      {} as PageRefreshService,
    );

    await processor.handleRecomputeModules({ data: { workspaceId: 'ws-1' } });
    await processor.handleRecomputeModules({ data: {} });

    expect(recomputeModules.mock.calls).toEqual([['ws-1'], [undefined]]);
  });
});

describe('retrying citations that could not be read', () => {
  function processorWith(stillUnknown: number) {
    const retryUnknown = jest.fn(async () => ({ stillUnknown }));
    const processor = new PagesProcessor(
      {} as PageEntriesService,
      { retryUnknown } as unknown as EntryCitationsService,
      {} as KnowledgeTriageService,
      {} as KnowledgeUpkeepService,
      {} as KnowledgeConventionsService,
      {} as KnowledgeGapsService,
      {} as PageRefreshService,
    );

    return { processor, retryUnknown };
  }

  it('[KG-2.3] completes once every citation of the entry has been read', async () => {
    const { processor, retryUnknown } = processorWith(0);

    await expect(
      processor.handleRetryCitations({ data: { entryId: 'entry-1' } }),
    ).resolves.toBeUndefined();
    expect(retryUnknown).toHaveBeenCalledWith('entry-1');
  });

  it('[KG-2.3] fails while any is still unread, so the queue tries again after its backoff', async () => {
    const { processor } = processorWith(2);

    await expect(
      processor.handleRetryCitations({ data: { entryId: 'entry-1' } }),
    ).rejects.toThrow('2 citation(s) of entry entry-1 could not be read yet');
  });

  it('[KG-2.3] retries one entry at a time, spaced further apart each time, and then gives up', () => {
    const options = retryCitationsJobOptions('entry-1');

    expect(options).toMatchObject({
      jobId: `${RETRY_CITATIONS_JOB}:entry-1`,
      attempts: RETRY_CITATIONS_ATTEMPTS,
      backoff: { type: 'exponential', delay: RETRY_CITATIONS_BACKOFF_MS },
      removeOnComplete: true,
    });
    expect(RETRY_CITATIONS_ATTEMPTS).toBeGreaterThan(1);
  });
});

describe('checking an entry again after a harmful signal', () => {
  it('[KG-3.4] checks the entry the job names against the code as it is now', async () => {
    const recheck = jest.fn(async () => ({ checked: 2 }));
    const processor = new PagesProcessor(
      {} as PageEntriesService,
      { recheck } as unknown as EntryCitationsService,
      {} as KnowledgeTriageService,
      {} as KnowledgeUpkeepService,
      {
        weigh: async (): Promise<null> => null,
      } as unknown as KnowledgeConventionsService,
      {} as KnowledgeGapsService,
      {} as PageRefreshService,
    );

    await expect(
      processor.handleRecheckEntry({ data: { entryId: 'entry-1' } }),
    ).resolves.toBeUndefined();
    expect(recheck).toHaveBeenCalledWith('entry-1');
  });

  it('[KG-3.4] folds signals against one entry into one check, and keeps no history of them', () => {
    // Several runs can blame an entry at once; while a check is waiting, a
    // second is the same work, so the job id is the entry's.
    expect(recheckEntryJobOptions('entry-1')).toEqual({
      jobId: `${RECHECK_ENTRY_JOB}:entry-1`,
      removeOnComplete: true,
      removeOnFail: true,
    });
    expect(recheckEntryJobOptions('entry-2').jobId).not.toBe(
      recheckEntryJobOptions('entry-1').jobId,
    );
  });
});

describe('triaging a new entry', () => {
  it('[KG-4.3] triages the entry the job names', async () => {
    const triage = jest.fn(async () => ({
      decisionId: 'decision-1',
      decision: 'ESCALATE',
      reasons: ['UNGROUNDED'],
      policy: null as string | null,
      mode: 'SHADOW',
      applied: false,
    }));
    const processor = new PagesProcessor(
      {} as PageEntriesService,
      {} as EntryCitationsService,
      { triage } as unknown as KnowledgeTriageService,
      {} as KnowledgeUpkeepService,
      {} as KnowledgeConventionsService,
      {} as KnowledgeGapsService,
      {} as PageRefreshService,
    );

    await expect(
      processor.handleTriageEntry({ data: { entryId: 'entry-1' } }),
    ).resolves.toBeUndefined();
    expect(triage).toHaveBeenCalledWith('entry-1');
  });

  it('[KG-4.3] fails when the pass fails, so the queue tries it again', async () => {
    const processor = new PagesProcessor(
      {} as PageEntriesService,
      {} as EntryCitationsService,
      {
        triage: jest.fn(async () => {
          throw new Error('typesense is down');
        }),
      } as unknown as KnowledgeTriageService,
      {} as KnowledgeUpkeepService,
      {} as KnowledgeConventionsService,
      {} as KnowledgeGapsService,
      {} as PageRefreshService,
    );

    await expect(
      processor.handleTriageEntry({ data: { entryId: 'entry-1' } }),
    ).rejects.toThrow('typesense is down');
  });
});

describe('knowledge gap issues', () => {
  const gapScheduler = (cron: string | undefined) => {
    let scheduler: typeof KnowledgeGapsScheduler = KnowledgeGapsScheduler;
    let interfaceCron = '';
    const saved = process.env.KNOWLEDGE_GAP_ISSUES_CRON;

    if (cron === undefined) {
      delete process.env.KNOWLEDGE_GAP_ISSUES_CRON;
    } else {
      process.env.KNOWLEDGE_GAP_ISSUES_CRON = cron;
    }

    // Read at import, as every schedule is, so imported afresh here.
    jest.isolateModules(() => {
      scheduler =
        jest.requireActual('./pages.processor').KnowledgeGapsScheduler;
      interfaceCron = jest.requireActual('./pages.interface').GAP_ISSUES_CRON;
    });

    if (saved === undefined) {
      delete process.env.KNOWLEDGE_GAP_ISSUES_CRON;
    } else {
      process.env.KNOWLEDGE_GAP_ISSUES_CRON = saved;
    }

    return { scheduler, interfaceCron };
  };

  it('[KG-6.4] registers the gap job weekly under a fixed id, replacing its earlier schedule', async () => {
    const { scheduler, interfaceCron } = gapScheduler(undefined);
    const queue = buildQueue([
      { name: GAP_ISSUES_JOB, key: 'old-gap-key' },
      { name: DECAY_JOB, key: 'decay-key' },
    ]);

    await new scheduler(queue).onModuleInit();

    expect(interfaceCron).toBe('0 4 * * 1');
    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('old-gap-key');
    expect(queue.removeRepeatableByKey).not.toHaveBeenCalledWith('decay-key');
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      GAP_ISSUES_JOB,
      {},
      expect.objectContaining({
        jobId: GAP_ISSUES_JOB_ID,
        repeat: { cron: '0 4 * * 1' },
        removeOnComplete: true,
        removeOnFail: 20,
      }),
    );
  });

  it('[KG-6.4] runs on the cron KNOWLEDGE_GAP_ISSUES_CRON gives, and not at all when it is off', async () => {
    const daily = gapScheduler('0 6 * * *');
    const queue = buildQueue();

    await new daily.scheduler(queue).onModuleInit();

    expect(queue.add.mock.calls[0][2].repeat).toEqual({ cron: '0 6 * * *' });

    for (const off of ['off', ' OFF ', '']) {
      const { scheduler } = gapScheduler(off);
      const stale = buildQueue([{ name: GAP_ISSUES_JOB, key: 'stale-key' }]);

      await new scheduler(stale).onModuleInit();

      // Turned off, the old schedule is cleared, not left running.
      expect(stale.removeRepeatableByKey).toHaveBeenCalledWith('stale-key');
      expect(stale.add).not.toHaveBeenCalled();
    }
  });

  it('[KG-6.4] does not stop the server coming up when the queue is unreachable', async () => {
    const queue = buildQueue();
    queue.getRepeatableJobs.mockRejectedValue(new Error('redis is down'));

    await expect(
      new KnowledgeGapsScheduler(queue).onModuleInit(),
    ).resolves.toBeUndefined();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('[KG-6.4] opens the gap issues when the job runs, and fails the run when opening them fails', async () => {
    const openIssues = jest.fn(async () => ({ opened: 2, answered: 1 }));
    const processor = new PagesProcessor(
      {} as PageEntriesService,
      {} as EntryCitationsService,
      {} as KnowledgeTriageService,
      {} as KnowledgeUpkeepService,
      {} as KnowledgeConventionsService,
      { openIssues } as unknown as KnowledgeGapsService,
      {} as PageRefreshService,
    );

    await processor.handleGapIssues();
    expect(openIssues).toHaveBeenCalledWith();

    openIssues.mockRejectedValueOnce(new Error('connection reset'));
    await expect(processor.handleGapIssues()).rejects.toThrow(
      'connection reset',
    );
  });
});

describe('conventions from review', () => {
  it('[KG-6.3] weighs a convention’s outcomes before checking its citations, after a harmful signal', async () => {
    const order: string[] = [];
    const weigh = jest.fn(async () => {
      order.push('weigh');
      return 'ARCHIVED' as const;
    });
    const recheck = jest.fn(async () => {
      order.push('recheck');
      return { checked: 1 };
    });
    const processor = new PagesProcessor(
      {} as PageEntriesService,
      { recheck } as unknown as EntryCitationsService,
      {} as KnowledgeTriageService,
      {} as KnowledgeUpkeepService,
      { weigh } as unknown as KnowledgeConventionsService,
      {} as KnowledgeGapsService,
      {} as PageRefreshService,
    );

    await processor.handleRecheckEntry({ data: { entryId: 'entry-1' } });

    expect(weigh).toHaveBeenCalledWith('entry-1');
    expect(recheck).toHaveBeenCalledWith('entry-1');
    expect(order).toEqual(['weigh', 'recheck']);
  });

  it('[KG-6.5] still checks the citations when weighing fails, and fails the job after', async () => {
    const weigh = jest.fn(async () => {
      throw new Error('connection reset');
    });
    const recheck = jest.fn(async () => ({ checked: 1 }));
    const processor = new PagesProcessor(
      {} as PageEntriesService,
      { recheck } as unknown as EntryCitationsService,
      {} as KnowledgeTriageService,
      {} as KnowledgeUpkeepService,
      { weigh } as unknown as KnowledgeConventionsService,
      {} as KnowledgeGapsService,
      {} as PageRefreshService,
    );

    await expect(
      processor.handleRecheckEntry({ data: { entryId: 'entry-1' } }),
    ).rejects.toThrow('connection reset');
    expect(recheck).toHaveBeenCalledWith('entry-1');
  });

  it('[KG-6.3] hands a finished run to be read for findings, once per run, tried again when it fails', async () => {
    const runFinished = jest.fn(async () => ({
      recorded: 2,
      candidates: [] as string[],
    }));
    const processor = new PagesProcessor(
      {} as PageEntriesService,
      {} as EntryCitationsService,
      {} as KnowledgeTriageService,
      {} as KnowledgeUpkeepService,
      { runFinished } as unknown as KnowledgeConventionsService,
      {} as KnowledgeGapsService,
      {} as PageRefreshService,
    );

    await processor.handleRunFindings({ data: { runId: 'run-1' } });
    expect(runFinished).toHaveBeenCalledWith('run-1');

    runFinished.mockRejectedValueOnce(new Error('connection reset'));
    await expect(
      processor.handleRunFindings({ data: { runId: 'run-1' } }),
    ).rejects.toThrow('connection reset');

    expect(runFindingsJobOptions('run-1')).toMatchObject({
      jobId: `${RUN_FINDINGS_JOB}:run-1`,
      removeOnComplete: true,
    });
    expect(runFindingsJobOptions('run-1').attempts).toBeGreaterThan(1);
  });
});

describe('a change that landed', () => {
  it('[KG-6.2] is handed to the upkeep, and fails the job while citations are unread', async () => {
    const codeLanded = jest.fn(async () => ({
      checked: 1,
      disputed: 0,
      proposed: 0,
      unread: 0,
    }));
    const processor = new PagesProcessor(
      {} as PageEntriesService,
      {} as EntryCitationsService,
      {} as KnowledgeTriageService,
      { codeLanded } as unknown as KnowledgeUpkeepService,
      {} as KnowledgeConventionsService,
      {} as KnowledgeGapsService,
      {} as PageRefreshService,
    );
    const data = {
      workspaceId: 'workspace-1',
      externalRepoId: 'repo-1',
      sha: 'a'.repeat(40),
      changedPaths: ['src/main.ts'],
    };

    await processor.handleCodeLanded({ data });

    expect(codeLanded).toHaveBeenCalledWith(data);

    codeLanded.mockRejectedValueOnce(new Error('1 citation(s) unread'));
    await expect(processor.handleCodeLanded({ data })).rejects.toThrow(
      'unread',
    );
  });
});

describe('the decay pass', () => {
  it('[KG-6.5] asks a person about the verified entries it may not archive, after archiving the rest', async () => {
    const order: string[] = [];
    const runDecay = jest.fn(async () => {
      order.push('archive');
      return { expiredProposed: 0, archivedStanding: 2 };
    });
    const proposeUnused = jest.fn(async () => {
      order.push('ask');
      return 1;
    });
    const openOwedIssues = jest.fn(async () => {
      order.push('owed');
      return 0;
    });

    await new PagesProcessor(
      { runDecay } as unknown as PageEntriesService,
      {} as EntryCitationsService,
      {} as KnowledgeTriageService,
      { proposeUnused, openOwedIssues } as unknown as KnowledgeUpkeepService,
      {} as KnowledgeConventionsService,
      {} as KnowledgeGapsService,
      {} as PageRefreshService,
    ).handleDecay();

    expect(order).toEqual(['archive', 'ask', 'owed']);
    expect(proposeUnused).toHaveBeenCalledWith();
  });

  it('[KG-6.2] opens the correction issues failed runs owed, in every workspace', async () => {
    const openOwedIssues = jest.fn(async () => 2);

    await new PagesProcessor(
      {
        runDecay: async () => ({ expiredProposed: 0, archivedStanding: 0 }),
      } as unknown as PageEntriesService,
      {} as EntryCitationsService,
      {} as KnowledgeTriageService,
      {
        proposeUnused: async () => 0,
        openOwedIssues,
      } as unknown as KnowledgeUpkeepService,
      {} as KnowledgeConventionsService,
      {} as KnowledgeGapsService,
      {} as PageRefreshService,
    ).handleDecay();

    expect(openOwedIssues).toHaveBeenCalledWith();
  });
});

describe('refreshing generated pages', () => {
  const refreshScheduler = (cron: string | undefined) => {
    let scheduler: typeof PageRefreshScheduler = PageRefreshScheduler;
    let interfaceCron = '';
    const saved = process.env.KNOWLEDGE_PAGE_REFRESH_CRON;

    if (cron === undefined) {
      delete process.env.KNOWLEDGE_PAGE_REFRESH_CRON;
    } else {
      process.env.KNOWLEDGE_PAGE_REFRESH_CRON = cron;
    }

    jest.isolateModules(() => {
      scheduler = jest.requireActual('./pages.processor').PageRefreshScheduler;
      interfaceCron = jest.requireActual('./pages.interface').PAGE_REFRESH_CRON;
    });

    if (saved === undefined) {
      delete process.env.KNOWLEDGE_PAGE_REFRESH_CRON;
    } else {
      process.env.KNOWLEDGE_PAGE_REFRESH_CRON = saved;
    }

    return { scheduler, interfaceCron };
  };
  const processorWith = (pageRefresh: Partial<PageRefreshService>) =>
    new PagesProcessor(
      {} as PageEntriesService,
      {} as EntryCitationsService,
      {} as KnowledgeTriageService,
      {} as KnowledgeUpkeepService,
      {} as KnowledgeConventionsService,
      {} as KnowledgeGapsService,
      pageRefresh as PageRefreshService,
    );

  it('[KG-7.2] looks for pages due a rebuild hourly under a fixed id, replacing its earlier schedule', async () => {
    const { scheduler, interfaceCron } = refreshScheduler(undefined);
    const queue = buildQueue([
      { name: PAGE_REFRESH_JOB, key: 'old-refresh-key' },
      { name: DECAY_JOB, key: 'decay-key' },
    ]);

    await new scheduler(queue).onModuleInit();

    expect(interfaceCron).toBe('23 * * * *');
    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('old-refresh-key');
    expect(queue.removeRepeatableByKey).not.toHaveBeenCalledWith('decay-key');
    expect(queue.add).toHaveBeenCalledWith(
      PAGE_REFRESH_JOB,
      {},
      expect.objectContaining({
        jobId: PAGE_REFRESH_JOB_ID,
        repeat: { cron: '23 * * * *' },
      }),
    );
  });

  it('[KG-7.2] runs on the cron KNOWLEDGE_PAGE_REFRESH_CRON gives, and not at all when it is off', async () => {
    const often = refreshScheduler('*/10 * * * *');
    const queue = buildQueue();

    await new often.scheduler(queue).onModuleInit();
    expect(queue.add.mock.calls[0][2].repeat).toEqual({
      cron: '*/10 * * * *',
    });

    const { scheduler } = refreshScheduler('off');
    const stale = buildQueue([{ name: PAGE_REFRESH_JOB, key: 'stale-key' }]);

    await new scheduler(stale).onModuleInit();
    expect(stale.removeRepeatableByKey).toHaveBeenCalledWith('stale-key');
    expect(stale.add).not.toHaveBeenCalled();

    const down = buildQueue();
    down.getRepeatableJobs.mockRejectedValue(new Error('redis is down'));
    await expect(
      new PageRefreshScheduler(down).onModuleInit(),
    ).resolves.toBeUndefined();
  });

  it('[KG-7.2] hands the look to the refresh service', async () => {
    const refreshDue = jest.fn(async () => ({ checked: 3, written: 1 }));

    await processorWith({ refreshDue }).handlePageRefresh();

    expect(refreshDue).toHaveBeenCalledWith();
  });

  it('[KG-7.2] [KG-7.3] builds the page a job names, and fails the job only when the evidence or the answer could not be read', async () => {
    const outcomes: Array<[RefreshOutcome, boolean]> = [
      ['written', false],
      ['no-change', false],
      ['too-soon', false],
      ['unchanged', false],
      ['no-evidence', false],
      ['not-generated', false],
      ['raced', false],
      ['retrieval-failed', true],
      ['writer-failed', true],
    ];

    for (const [outcome, fails] of outcomes) {
      const refresh = jest.fn(async () => ({ outcome }));
      const run = processorWith({ refresh }).handleRefreshPage({
        data: { pageId: 'page-1' },
      });

      if (fails) {
        await expect(run).rejects.toThrow(outcome);
      } else {
        await expect(run).resolves.toBeUndefined();
      }
      expect(refresh).toHaveBeenCalledWith('page-1');
    }

    // One job per page at a time.
    expect(refreshPageJobOptions('page-1')).toMatchObject({
      jobId: `${REFRESH_PAGE_JOB}:page-1`,
      attempts: 2,
    });
  });
});
