import { BullModule } from '@nestjs/bull';
import { Global, Module } from '@nestjs/common';

import { TeamDashboardModule } from '../team-dashboard.module';
import { StuckAnalysisService } from './stuck-analysis.service';
import { TEAM_ANALYSIS_QUEUE } from './team-activity.interface';
import { TeamActivityService } from './team-activity.service';
import { TeamAnalysisProcessor } from './team-analysis.processor';

/**
 * Global on purpose. IssuesService and IssueCommentsService are provided
 * directly by more than one module (WebhookModule provides
 * IssueCommentsService), and Nest resolves a constructor where the provider
 * is declared. A global module puts TeamActivityService in reach of every one
 * of them without a change to each.
 */
@Global()
@Module({
  imports: [
    BullModule.registerQueue({ name: TEAM_ANALYSIS_QUEUE }),
    TeamDashboardModule,
  ],
  providers: [TeamActivityService, StuckAnalysisService, TeamAnalysisProcessor],
  exports: [TeamActivityService],
})
export class TeamActivityModule {}
