import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bull';

import { LoggerService } from 'modules/logger/logger.service';

import EntryCitationsService from './entry-citations.service';
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
  RETRY_CITATIONS_JOB,
  RUN_FINDINGS_JOB,
  STANDING_ENTRY_DECAY_DAYS,
  TRIAGE_ENTRY_JOB,
} from './pages.interface';
import KnowledgeTriageService from './triage/knowledge-triage.service';
import KnowledgeConventionsService from './upkeep/knowledge-conventions.service';
import KnowledgeGapsService from './upkeep/knowledge-gaps.service';
import KnowledgeUpkeepService from './upkeep/knowledge-upkeep.service';

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
  ) {}

  /** Rebuilds every generated page that is due. See `PageRefreshService`. */
  @Process(PAGE_REFRESH_JOB)
  async handlePageRefresh() {
    const { checked, written } = await this.pageRefresh.refreshDue();

    this.logger.info({
      message: `Looked at ${checked} generated page(s); rebuilt ${written}`,
      where: 'PagesProcessor.handlePageRefresh',
    });
  }

  /** Builds one generated page, if it is due: when made, or asked anew. */
  @Process(REFRESH_PAGE_JOB)
  async handleRefreshPage(job: { data: { pageId: string } }) {
    const { outcome } = await this.pageRefresh.refresh(job.data.pageId);

    // A refresh that could not read its evidence or its writer's answer is
    // tried again; the next look would get to it too, but later.
    if (outcome === 'retrieval-failed' || outcome === 'writer-failed') {
      throw new Error(
        `Generated page ${job.data.pageId} was not built (${outcome})`,
      );
    }
  }

  /**
   * Triages one new entry. A pass that throws is tried again by Bull; one
   * that finds nothing to decide (the entry is gone, triaged, or triage is
   * off) returns without a decision.
   */
  @Process(TRIAGE_ENTRY_JOB)
  async handleTriageEntry(job: { data: { entryId: string } }) {
    const outcome = await this.triage.triage(job.data.entryId);

    if (!outcome) {
      return;
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
      message: `Triage (${outcome.mode.toLowerCase()}) decided ${outcome.decision} for entry ${job.data.entryId}${detail}`,
      where: 'PagesProcessor.handleTriageEntry',
    });
  }

  /**
   * Reads again an entry's citations that the server could not read when the
   * entry was written. Throws while any is still unread, so Bull tries again
   * after its backoff; once the attempts are spent the citations stay
   * UNKNOWN, which never counts against the entry.
   */
  @Process(RETRY_CITATIONS_JOB)
  async handleRetryCitations(job: { data: { entryId: string } }) {
    const { stillUnknown } = await this.entryCitations.retryUnknown(
      job.data.entryId,
    );

    if (stillUnknown > 0) {
      throw new Error(
        `${stillUnknown} citation(s) of entry ${job.data.entryId} could not be read yet`,
      );
    }
  }

  /**
   * Checks an entry's citations again after a run it was served to went wrong
   * in code it speaks about. A convention the gardener proposed has its
   * outcomes weighed first, since outcomes are what take one out of use.
   */
  @Process(RECHECK_ENTRY_JOB)
  async handleRecheckEntry(job: { data: { entryId: string } }) {
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

    this.logger.info({
      message: `Checked ${checked} citation(s) of entry ${job.data.entryId} after a harmful signal`,
      where: 'PagesProcessor.handleRecheckEntry',
    });

    if (failed) {
      throw failure;
    }
  }

  /**
   * Records a finished run's review findings, and proposes a convention for
   * any the reviewer has given in enough runs.
   */
  @Process(RUN_FINDINGS_JOB)
  async handleRunFindings(job: { data: { runId: string } }) {
    await this.conventions.runFinished(job.data.runId);
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
  async handleCodeLanded(job: { data: CodeLandedJob }) {
    await this.upkeep.codeLanded(job.data);
  }

  /**
   * Opens issues for the questions the knowledge keeps failing to answer, in
   * every workspace, and marks answered those whose issue now has an accepted
   * answer. A run that fails part way is tried again whole; the gaps it had
   * opened issues for are not opened again.
   */
  @Process(GAP_ISSUES_JOB)
  async handleGapIssues() {
    const { opened, answered } = await this.gaps.openIssues();

    this.logger.info({
      message: `Opened ${opened} knowledge gap issue(s), and marked ${answered} gap(s) answered`,
      where: 'PagesProcessor.handleGapIssues',
    });
  }

  /**
   * Re-resolves entries' scopes to modules, for one workspace or, with none
   * given, for every workspace.
   */
  @Process(RECOMPUTE_MODULES_JOB)
  async handleRecomputeModules(job: { data: { workspaceId?: string } }) {
    const { changed } = await this.pageEntriesService.recomputeModules(
      job.data?.workspaceId,
    );

    this.logger.info({
      message:
        `Resolved entry scopes to modules for ` +
        `${job.data?.workspaceId ?? 'every workspace'}: ${changed} changed`,
      where: 'PagesProcessor.handleRecomputeModules',
    });
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
  async handleDecay() {
    let expiredProposed: number;
    let archivedStanding: number;
    let proposedVerified: number;
    let owedIssues: number;

    try {
      ({ expiredProposed, archivedStanding } =
        await this.pageEntriesService.runDecay());
      // What decay may not archive alone, it asks a person about.
      proposedVerified = await this.upkeep.proposeUnused();
      // Correction issues a failed run owed, in workspaces no change has
      // landed in since, whose own runs would otherwise open them.
      owedIssues = await this.upkeep.openOwedIssues();
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
        `${archivedStanding} unused standing entr(ies), asked a person ` +
        `about ${proposedVerified} unused verified entr(ies), and opened ` +
        `${owedIssues} owed correction issue(s)`,
      where: 'PagesProcessor.handleDecay',
    });
  }
}
