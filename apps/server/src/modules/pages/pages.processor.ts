import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { KnowledgeTriageTrigger } from '@prisma/client';
import { Queue } from 'bull';

import { LoggerService } from 'modules/logger/logger.service';

import EntryCitationsService from './entry-citations.service';
import KnowledgeJobRunsService, {
  type JobRunCounts,
  type JobRunSubject,
  type RecordedJob,
} from './gardener/knowledge-job-runs.service';
import PageRefreshService from './generated/page-refresh.service';
import PageEntriesService from './page-entries.service';
import {
  CODE_LANDED_JOB,
  type CodeLandedJob,
  DECAY_CRON,
  DECAY_JOB,
  DECAY_JOB_ID,
  GAP_ISSUES_CRON,
  GAP_ISSUES_JOB,
  GAP_ISSUES_JOB_ID,
  PAGE_REFRESH_CRON,
  PAGE_REFRESH_JOB,
  PAGE_REFRESH_JOB_ID,
  PAGES_QUEUE,
  PROPOSED_ENTRY_EXPIRY_DAYS,
  RECHECK_ENTRY_JOB,
  RECOMPUTE_MODULES_JOB,
  recomputeModulesJobOptions,
  REFRESH_PAGE_JOB,
  retriageJobOptions,
  RETRY_CITATIONS_JOB,
  RUN_FINDINGS_JOB,
  STANDING_ENTRY_DECAY_DAYS,
  TRIAGE_ENTRY_JOB,
  type TriageEntryJob,
  VERIFY_ENTRY_JOB,
} from './pages.interface';
import KnowledgeTriageService from './triage/knowledge-triage.service';
import KnowledgeConventionsService from './upkeep/knowledge-conventions.service';
import KnowledgeGapsService from './upkeep/knowledge-gaps.service';
import KnowledgeUpkeepService, {
  UnreadCitations,
} from './upkeep/knowledge-upkeep.service';
import KnowledgeVerifierService from './verifier/knowledge-verifier.service';

/**
 * The scheduler for the decay pass.
 *
 * A Bull repeatable job rather than an in-process timer, because Redis is what
 * makes the schedule survive a restart *and* stay singular across replicas. An
 * in-process cron would fire once per replica, and a bank being groomed three
 * times a night by three servers is a bank whose logs cannot be trusted to say
 * what happened to an entry.
 */
@Injectable()
export class PagesScheduler implements OnModuleInit {
  private readonly logger: LoggerService = new LoggerService('PagesScheduler');

  constructor(@InjectQueue(PAGES_QUEUE) private pagesQueue: Queue) {}

  async onModuleInit() {
    // Matching the pattern the vector collections already set at boot: setup
    // that fails should degrade the feature, not stop the server coming up.
    try {
      await this.scheduleDecay();
    } catch (error) {
      this.logger.error({
        message: `Could not schedule the knowledge decay pass: ${error}`,
        where: 'PagesScheduler.onModuleInit',
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  private async scheduleDecay() {
    const cron = await scheduleRepeatable(
      this.pagesQueue,
      DECAY_JOB,
      DECAY_JOB_ID,
      DECAY_CRON,
    );

    if (!cron) {
      this.logger.info({
        message:
          'Knowledge decay is disabled (PAGE_DECAY_CRON is off); untriaged ' +
          'entries will accumulate until someone triages them',
        where: 'PagesScheduler.scheduleDecay',
      });
      return;
    }

    this.logger.info({
      message:
        `Knowledge decay scheduled (${cron}): untriaged entries archive after ` +
        `${PROPOSED_ENTRY_EXPIRY_DAYS}d, unserved standing entries after ` +
        `${STANDING_ENTRY_DECAY_DAYS}d`,
      where: 'PagesScheduler.scheduleDecay',
    });
  }
}

/**
 * The scheduler for the job that opens issues for knowledge gaps, registered
 * the way the decay pass is and for the same reasons.
 */
@Injectable()
export class KnowledgeGapsScheduler implements OnModuleInit {
  private readonly logger: LoggerService = new LoggerService(
    'KnowledgeGapsScheduler',
  );

  constructor(@InjectQueue(PAGES_QUEUE) private pagesQueue: Queue) {}

  async onModuleInit() {
    try {
      const cron = await scheduleRepeatable(
        this.pagesQueue,
        GAP_ISSUES_JOB,
        GAP_ISSUES_JOB_ID,
        GAP_ISSUES_CRON,
      );

      this.logger.info({
        message: cron
          ? `Knowledge gap issues scheduled (${cron})`
          : 'Knowledge gap issues are disabled (KNOWLEDGE_GAP_ISSUES_CRON is ' +
            'off); unanswered questions are listed, and no issue is opened',
        where: 'KnowledgeGapsScheduler.onModuleInit',
      });
    } catch (error) {
      this.logger.error({
        message: `Could not schedule knowledge gap issues: ${error}`,
        where: 'KnowledgeGapsScheduler.onModuleInit',
        error: error instanceof Error ? error : undefined,
      });
    }
  }
}

/**
 * The scheduler for the look for generated pages due a rebuild. A look finds
 * nothing to do far more often than not: each page is rebuilt only when its
 * evidence changed, and no sooner than its workspace's interval.
 */
@Injectable()
export class PageRefreshScheduler implements OnModuleInit {
  private readonly logger: LoggerService = new LoggerService(
    'PageRefreshScheduler',
  );

  constructor(@InjectQueue(PAGES_QUEUE) private pagesQueue: Queue) {}

  async onModuleInit() {
    try {
      const cron = await scheduleRepeatable(
        this.pagesQueue,
        PAGE_REFRESH_JOB,
        PAGE_REFRESH_JOB_ID,
        PAGE_REFRESH_CRON,
      );

      this.logger.info({
        message: cron
          ? `Generated page refreshes scheduled (${cron})`
          : 'Generated page refreshes are disabled (KNOWLEDGE_PAGE_REFRESH_CRON ' +
            'is off); a generated page is built only when it is made or its ' +
            'question changes',
        where: 'PageRefreshScheduler.onModuleInit',
      });
    } catch (error) {
      this.logger.error({
        message: `Could not schedule generated page refreshes: ${error}`,
        where: 'PageRefreshScheduler.onModuleInit',
        error: error instanceof Error ? error : undefined,
      });
    }
  }
}

/**
 * Registers a repeatable job on its cron, and returns the cron, or null when
 * it is empty or `off` and the job is left unscheduled.
 *
 * Clearing first is what makes the cron *configurable* rather than merely set
 * once. Bull keys a repeatable job by its cron expression, so changing the
 * variable without this leaves the old schedule registered and the job quietly
 * runs on both.
 */
async function scheduleRepeatable(
  queue: Queue,
  name: string,
  jobId: string,
  configured: string,
): Promise<string | null> {
  const existing = await queue.getRepeatableJobs();
  await Promise.all(
    existing
      .filter((job) => job.name === name)
      .map((job) => queue.removeRepeatableByKey(job.key)),
  );

  const cron = configured.trim();
  if (!cron || cron.toLowerCase() === 'off') {
    return null;
  }

  await queue.add(
    name,
    {},
    {
      jobId,
      repeat: { cron },
      removeOnComplete: true,
      // Failures are kept, successes are not. Discarding a failed run left
      // the queue looking idle and healthy while the job had in fact stopped,
      // the same symptom as no scheduler at all. Bounded so a job that fails
      // every time cannot fill Redis.
      removeOnFail: 20,
    },
  );

  return cron;
}

/**
 * Resolves every entry's scope to modules once at boot.
 *
 * Queued rather than run here, so boot never waits on it. Modules can change
 * while the server is down (a migration, an edit whose job was lost), and
 * entries written before modules were resolved have none; one pass at boot
 * settles both. After that, edits to a module's repositories queue their own.
 */
@Injectable()
export class EntryModulesScheduler implements OnModuleInit {
  private readonly logger: LoggerService = new LoggerService(
    'EntryModulesScheduler',
  );

  constructor(@InjectQueue(PAGES_QUEUE) private pagesQueue: Queue) {}

  async onModuleInit() {
    try {
      await this.pagesQueue.add(
        RECOMPUTE_MODULES_JOB,
        {},
        recomputeModulesJobOptions(undefined),
      );
    } catch (error) {
      this.logger.error({
        message: `Could not queue the entry module recompute: ${error}`,
        where: 'EntryModulesScheduler.onModuleInit',
        error: error instanceof Error ? error : undefined,
      });
    }
  }
}

@Processor(PAGES_QUEUE)
export class PagesProcessor {
  private readonly logger: LoggerService = new LoggerService('PagesProcessor');

  constructor(
    private pageEntriesService: PageEntriesService,
    private entryCitations: EntryCitationsService,
    private triage: KnowledgeTriageService,
    private upkeep: KnowledgeUpkeepService,
    private conventions: KnowledgeConventionsService,
    private gaps: KnowledgeGapsService,
    private pageRefresh: PageRefreshService,
    @Optional() @InjectQueue(PAGES_QUEUE) private pagesQueue?: Queue,
    @Optional() private verifier?: KnowledgeVerifierService,
    @Optional() private jobRuns?: KnowledgeJobRunsService,
  ) {}

  /**
   * Runs a job's work, and records the run: what started it, how long it
   * took, what it counted, and its error. With no recorder, it only runs.
   */
  private async recorded<T>(
    name: string,
    job: RecordedJob | undefined,
    subject: JobRunSubject,
    work: () => Promise<T>,
    counts?: (result: T) => JobRunCounts | undefined,
  ): Promise<void> {
    if (this.jobRuns) {
      await this.jobRuns.record(name, job, subject, work, counts);
    } else {
      await work();
    }
  }

  /**
   * Queues one more triage pass for entries whose evidence changed. Triage
   * decides again only about an entry that waits after an escalation, and
   * only when the evidence differs, so a pass for any other entry decides
   * nothing. Best effort: an entry not triaged again waits for a person.
   */
  private async triageAgain(
    entryIds: string[],
    trigger: KnowledgeTriageTrigger,
  ): Promise<void> {
    for (const entryId of new Set(entryIds)) {
      try {
        await this.pagesQueue?.add(
          TRIAGE_ENTRY_JOB,
          { entryId, trigger },
          retriageJobOptions(entryId, trigger),
        );
      } catch (error) {
        this.logger.warn({
          message: `Could not queue triage of entry ${entryId} again (${trigger}): ${error}`,
          where: 'PagesProcessor.triageAgain',
        });
      }
    }
  }

  /** Rebuilds every generated page that is due. See `PageRefreshService`. */
  @Process(PAGE_REFRESH_JOB)
  async handlePageRefresh(job?: RecordedJob) {
    return this.recorded(PAGE_REFRESH_JOB, job, {}, async () => {
      const { checked, written } = await this.pageRefresh.refreshDue();

      this.logger.info({
        message: `Looked at ${checked} generated page(s); rebuilt ${written}`,
        where: 'PagesProcessor.handlePageRefresh',
      });

      return { checked, written };
    });
  }

  /** Builds one generated page, if it is due: when made, or asked anew. */
  @Process(REFRESH_PAGE_JOB)
  async handleRefreshPage(job: RecordedJob & { data: { pageId: string } }) {
    return this.recorded(
      REFRESH_PAGE_JOB,
      job,
      { subjectId: job.data.pageId },
      async () => {
        const { outcome } = await this.pageRefresh.refresh(job.data.pageId);

        // A refresh that could not read its evidence or its writer's answer is
        // tried again; the next look would get to it too, but later.
        if (outcome === 'retrieval-failed' || outcome === 'writer-failed') {
          throw new Error(
            `Generated page ${job.data.pageId} was not built (${outcome})`,
          );
        }

        return { outcome };
      },
    );
  }

  /**
   * Triages one entry: a new one, or one whose evidence changed while it
   * waits. A pass that throws is tried again by Bull; one that finds nothing
   * to decide (the entry is gone, decided about, or triage is off) returns
   * without a decision.
   */
  @Process(TRIAGE_ENTRY_JOB)
  async handleTriageEntry(job: RecordedJob & { data: TriageEntryJob }) {
    return this.recorded(
      TRIAGE_ENTRY_JOB,
      job,
      { entryId: job.data.entryId },
      async () => {
        const outcome = await this.triage.triage(
          job.data.entryId,
          process.env,
          job.data.trigger ?? KnowledgeTriageTrigger.WRITTEN,
        );

        if (!outcome) {
          return { decided: false };
        }

        const detail = [
          outcome.reasons.length ? ` (${outcome.reasons.join(', ')})` : '',
          outcome.policy ? ` (policy ${outcome.policy})` : '',
          outcome.backedOffFrom
            ? ` instead of ${outcome.backedOffFrom}, which is backed off`
            : '',
          outcome.applied ? ', applied' : '',
          outcome.audit ? ', drawn for audit' : '',
        ].join('');

        this.logger.info({
          message: `Triage (${outcome.mode.toLowerCase()}, ${outcome.trigger.toLowerCase()}) decided ${outcome.decision} for entry ${job.data.entryId}${detail}`,
          where: 'PagesProcessor.handleTriageEntry',
        });

        return {
          decided: true,
          decision: outcome.decision,
          mode: outcome.mode,
          trigger: outcome.trigger,
          applied: outcome.applied,
          audit: outcome.audit,
        };
      },
    );
  }

  /**
   * Looks for evidence of an entry that cites none. Not tried again: a look
   * that fails records why, and the entry goes to a person.
   */
  @Process(VERIFY_ENTRY_JOB)
  async handleVerifyEntry(job: RecordedJob & { data: { entryId: string } }) {
    return this.recorded(
      VERIFY_ENTRY_JOB,
      job,
      { entryId: job.data.entryId },
      async () => {
        const state = await this.verifier?.verify(job.data.entryId);

        if (state) {
          this.logger.info({
            message: `The verifier looked for evidence of entry ${job.data.entryId}: ${state}`,
            where: 'PagesProcessor.handleVerifyEntry',
          });
        }

        return { state: state ?? null };
      },
    );
  }

  /**
   * Reads again an entry's citations that the server could not read when the
   * entry was written. Throws while any is still unread, so Bull tries again
   * after its backoff; once the attempts are spent the citations stay
   * UNKNOWN, which never counts against the entry.
   */
  @Process(RETRY_CITATIONS_JOB)
  async handleRetryCitations(job: RecordedJob & { data: { entryId: string } }) {
    return this.recorded(
      RETRY_CITATIONS_JOB,
      job,
      { entryId: job.data.entryId },
      async () => {
        const { stillUnknown, read } = await this.entryCitations.retryUnknown(
          job.data.entryId,
        );

        if (read > 0) {
          await this.triageAgain(
            [job.data.entryId],
            KnowledgeTriageTrigger.CITATIONS_CHECKED,
          );
        }

        if (stillUnknown > 0) {
          throw new Error(
            `${stillUnknown} citation(s) of entry ${job.data.entryId} could not be read yet`,
          );
        }

        return { read, stillUnknown };
      },
    );
  }

  /**
   * Checks an entry's citations again after a run it was served to went wrong
   * in code it speaks about, or when the outside page it cites is due for a
   * new read. A convention the gardener proposed has its outcomes weighed
   * first, since outcomes are what take one out of use.
   */
  @Process(RECHECK_ENTRY_JOB)
  async handleRecheckEntry(job: RecordedJob & { data: { entryId: string } }) {
    return this.recorded(
      RECHECK_ENTRY_JOB,
      job,
      { entryId: job.data.entryId },
      async () => {
        // Weighing failing does not cost the re-check: the job is not retried,
        // and the citations are worth checking either way. The failure is
        // raised once they are, so the job is still recorded as failed.
        let failed = false;
        let failure: unknown;

        try {
          await this.conventions.weigh(job.data.entryId);
        } catch (error) {
          failed = true;
          failure = error;
        }

        const { checked } = await this.entryCitations.recheck(job.data.entryId);

        if (checked > 0) {
          await this.triageAgain(
            [job.data.entryId],
            KnowledgeTriageTrigger.CITATIONS_CHECKED,
          );
        }

        this.logger.info({
          message: `Checked ${checked} citation(s) of entry ${job.data.entryId}`,
          where: 'PagesProcessor.handleRecheckEntry',
        });

        if (failed) {
          throw failure;
        }

        return { checked };
      },
    );
  }

  /**
   * Records a finished run's review findings, and proposes a convention for
   * any the reviewer has given in enough runs.
   */
  @Process(RUN_FINDINGS_JOB)
  async handleRunFindings(job: RecordedJob & { data: { runId: string } }) {
    return this.recorded(
      RUN_FINDINGS_JOB,
      job,
      { agentRunId: job.data.runId },
      async () => {
        await this.conventions.runFinished(job.data.runId);
      },
    );
  }

  /**
   * Checks the knowledge a change that landed on a default branch touches,
   * and acts on what no longer holds. Throws while citations it touches are
   * still unread, or were read before a person last acted on their entry,
   * so Bull tries again after its backoff. While the head is still the
   * change's commit, a retry reads only those, as the rest are stored as
   * read at it.
   */
  @Process(CODE_LANDED_JOB)
  async handleCodeLanded(job: RecordedJob & { data: CodeLandedJob }) {
    return this.recorded(
      CODE_LANDED_JOB,
      job,
      { workspaceId: job.data.workspaceId, subjectId: job.data.sha },
      async () => {
        let waiting: string[];

        try {
          ({ waiting } = await this.upkeep.codeLanded(job.data));
        } catch (error) {
          // What was checked is stored, though the rest is tried again.
          if (error instanceof UnreadCitations) {
            await this.triageAgain(
              error.waiting,
              KnowledgeTriageTrigger.CODE_CHANGED,
            );
          }

          throw error;
        }

        await this.triageAgain(waiting, KnowledgeTriageTrigger.CODE_CHANGED);

        return { waiting: waiting.length };
      },
    );
  }

  /**
   * Opens issues for the questions the knowledge keeps failing to answer, in
   * every workspace, and marks answered those whose issue now has an accepted
   * answer. A run that fails part way is tried again whole; the gaps it had
   * opened issues for are not opened again.
   */
  @Process(GAP_ISSUES_JOB)
  async handleGapIssues(job?: RecordedJob) {
    return this.recorded(GAP_ISSUES_JOB, job, {}, async () => {
      const { opened, answered } = await this.gaps.openIssues();

      this.logger.info({
        message: `Opened ${opened} knowledge gap issue(s), and marked ${answered} gap(s) answered`,
        where: 'PagesProcessor.handleGapIssues',
      });

      return { opened, answered };
    });
  }

  /**
   * Re-resolves entries' scopes to modules, for one workspace or, with none
   * given, for every workspace.
   */
  @Process(RECOMPUTE_MODULES_JOB)
  async handleRecomputeModules(
    job: RecordedJob & { data: { workspaceId?: string } },
  ) {
    return this.recorded(
      RECOMPUTE_MODULES_JOB,
      job,
      { workspaceId: job.data?.workspaceId },
      async () => {
        const { changed } = await this.pageEntriesService.recomputeModules(
          job.data?.workspaceId,
        );

        this.logger.info({
          message:
            `Resolved entry scopes to modules for ` +
            `${job.data?.workspaceId ?? 'every workspace'}: ${changed} changed`,
          where: 'PagesProcessor.handleRecomputeModules',
        });

        return { changed };
      },
    );
  }

  /**
   * Runs decay across every workspace.
   *
   * Deliberately unscoped: the windows are a property of the deployment, not of
   * a workspace, and a per-workspace fan-out would need a job per workspace to
   * express the same thing. `runDecay` is idempotent, so a retry after a
   * partial failure re-archives what it already archived and changes nothing.
   */
  @Process(DECAY_JOB)
  async handleDecay(job?: RecordedJob) {
    return this.recorded(DECAY_JOB, job, {}, async () => {
      let expiredProposed: number;
      let archivedStanding: number;
      let archivedProvisional: number;
      let promotedProvisional: number;
      let proposedVerified: number;
      let owedIssues: number;
      let verified: number;
      let triaged: number;
      let observed: number;

      try {
        ({
          expiredProposed,
          archivedStanding,
          archivedProvisional,
          promotedProvisional,
        } = await this.pageEntriesService.runDecay());
        // What decay may not archive alone, it asks a person about.
        proposedVerified = await this.upkeep.proposeUnused();
        // Correction issues a failed run owed, in workspaces no change has
        // landed in since, whose own runs would otherwise open them.
        owedIssues = await this.upkeep.openOwedIssues();
        // Entries that wait as UNGROUNDED with no look by the verifier.
        verified = (await this.verifier?.sweep()) ?? 0;
        // Entries that wait with no decision triage acted on: every pass
        // failed, it decided under earlier rules, or it decided only in
        // shadow and is now on.
        triaged = await this.triage.sweep();
        // Facts observed on an outside page that the server last read over
        // 30 days ago.
        observed = await this.entryCitations.recheckObservedLater();
      } catch (error) {
        // Said out loud, because the alternative is silence. The only other
        // signal this pass gives is the line below, and "no line" reads exactly
        // like "no schedule" — the bug this file was written to fix. Rethrown so
        // Bull still records the run as failed.
        this.logger.error({
          message: `Knowledge decay pass failed: ${error}`,
          where: 'PagesProcessor.handleDecay',
          error: error instanceof Error ? error : undefined,
        });

        throw error;
      }

      this.logger.info({
        message:
          `Knowledge decay archived ${expiredProposed} untriaged and ` +
          `${archivedStanding} unused standing entr(ies), archived ` +
          `${archivedProvisional} and settled ${promotedProvisional} ` +
          `provisional entr(ies) by use, asked a person ` +
          `about ${proposedVerified} unused verified entr(ies), opened ` +
          `${owedIssues} owed correction issue(s), asked the verifier ` +
          `about ${verified} entr(ies), queued triage again for ${triaged}, ` +
          `and queued a new read of the outside ` +
          `pages of ${observed} observed entr(ies)`,
        where: 'PagesProcessor.handleDecay',
      });

      // The record of these runs is kept for as long as the gardener view
      // looks back, and no longer.
      const prunedJobRuns = (await this.jobRuns?.prune()) ?? 0;

      return {
        expiredProposed,
        archivedStanding,
        archivedProvisional,
        promotedProvisional,
        proposedVerified,
        owedIssues,
        verified,
        triaged,
        observed,
        prunedJobRuns,
      };
    });
  }
}
