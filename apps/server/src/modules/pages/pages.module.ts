import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';

import { IntegrationsModule } from 'modules/integrations/integrations.module';
import { IssuesModule } from 'modules/issues/issues.module';
import { LocalRepoModule } from 'modules/local-repo/local-repo.module';
import { UsersService } from 'modules/users/users.service';
import { VectorModule } from 'modules/vector/vector.module';

import CitationJudge from './citation-judge';
import EntryCitationsService from './entry-citations.service';
import PageRefreshService from './generated/page-refresh.service';
import PageWriter from './generated/page-writer';
import KnowledgeIndexService from './knowledge-index.service';
import { KnowledgeReviewController } from './knowledge-review.controller';
import KnowledgeReviewService from './knowledge-review.service';
import { KnowledgeController } from './knowledge.controller';
import KnowledgeService from './knowledge.service';
import PageLinksService from './page-links.service';
import { PageEntriesController } from './page-entries.controller';
import PageEntriesService from './page-entries.service';
import { PagesController } from './pages.controller';
import { PAGES_QUEUE } from './pages.interface';
import {
  EntryModulesScheduler,
  KnowledgeGapsScheduler,
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

@Module({
  imports: [
    VectorModule,
    // For reading the code a citation names, from whichever source holds it.
    IntegrationsModule,
    LocalRepoModule,
    // The gardener opens issues for knowledge that needs a person.
    IssuesModule,
    BullModule.registerQueue({ name: PAGES_QUEUE }),
  ],
  controllers: [
    PagesController,
    PageEntriesController,
    KnowledgeController,
    KnowledgeReviewController,
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
    KnowledgeAgreementService,
    KnowledgeReviewService,
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
