import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';

import { GitModule } from 'modules/git/git.module';
import { KnowledgeArmsService } from 'modules/agent-runs/knowledge-arms.service';
import { IssuesModule } from 'modules/issues/issues.module';
import { UsersService } from 'modules/users/users.service';
import { VectorModule } from 'modules/vector/vector.module';

import CitationJudge from './citation-judge';
import EntryCitationsService from './entry-citations.service';
import PageRefreshService from './generated/page-refresh.service';
import PageWriter from './generated/page-writer';
import KnowledgeInboxService from './knowledge-inbox.service';
import { KnowledgeGardenerController } from './gardener/knowledge-gardener.controller';
import KnowledgeGardenerService from './gardener/knowledge-gardener.service';
import KnowledgeJobRunsService from './gardener/knowledge-job-runs.service';
import KnowledgeRecordsService from './gardener/knowledge-records.service';
import KnowledgeIndexService from './knowledge-index.service';
import KnowledgeOverviewService from './knowledge-overview.service';
import { KnowledgeReviewController } from './knowledge-review.controller';
import KnowledgeReviewService from './knowledge-review.service';
import { KnowledgeController } from './knowledge.controller';
import KnowledgeService from './knowledge.service';
import LooseFactsService from './loose-facts.service';
import { PageEntriesController } from './page-entries.controller';
import PageEntriesService from './page-entries.service';
import PageLinksService from './page-links.service';
import { PagesController } from './pages.controller';
import { PAGES_QUEUE } from './pages.interface';
import {
  EntryModulesScheduler,
  KnowledgeGapsScheduler,
  KnowledgeIndexScheduler,
  PageRefreshScheduler,
  PagesProcessor,
  PagesScheduler,
} from './pages.processor';
import PagesService from './pages.service';
import RepoFileSourceService from './repo-file-source.service';
import KnowledgeAgreementService from './triage/knowledge-agreement.service';
import KnowledgeTriageService from './triage/knowledge-triage.service';
import TriageJudges from './triage/triage-judges';
import KnowledgeConventionsService from './upkeep/knowledge-conventions.service';
import KnowledgeGapsService from './upkeep/knowledge-gaps.service';
import KnowledgeIssues from './upkeep/knowledge-issues';
import KnowledgeUpkeepService from './upkeep/knowledge-upkeep.service';
import KnowledgeVerifierService from './verifier/knowledge-verifier.service';

@Module({
  imports: [
    VectorModule,
    // For reading the code a citation names, from the server's mirror of it.
    GitModule,
    // The gardener opens issues for knowledge that needs a person.
    IssuesModule,
    BullModule.registerQueue({ name: PAGES_QUEUE }),
  ],
  controllers: [
    PagesController,
    PageEntriesController,
    KnowledgeController,
    KnowledgeReviewController,
    KnowledgeGardenerController,
  ],
  providers: [
    PagesService,
    PageEntriesService,
    PageLinksService,
    KnowledgeService,
    KnowledgeIndexService,
    RepoFileSourceService,
    CitationJudge,
    EntryCitationsService,
    TriageJudges,
    KnowledgeTriageService,
    // Reaches the model keys of agent-runs through the module container, as
    // agent-runs imports this module.
    KnowledgeVerifierService,
    KnowledgeAgreementService,
    KnowledgeReviewService,
    KnowledgeInboxService,
    KnowledgeJobRunsService,
    KnowledgeRecordsService,
    KnowledgeGardenerService,
    // Reads only the database; the gardener view compares the two arms.
    KnowledgeArmsService,
    KnowledgeOverviewService,
    LooseFactsService,
    KnowledgeIssues,
    KnowledgeUpkeepService,
    KnowledgeConventionsService,
    KnowledgeGapsService,
    PageWriter,
    PageRefreshService,
    PagesScheduler,
    KnowledgeGapsScheduler,
    PageRefreshScheduler,
    EntryModulesScheduler,
    KnowledgeIndexScheduler,
    PagesProcessor,
    UsersService,
  ],
  exports: [
    PagesService,
    PageEntriesService,
    PageLinksService,
    KnowledgeService,
    // A run's end reports its review findings here.
    KnowledgeConventionsService,
  ],
})
export class PagesModule {}
