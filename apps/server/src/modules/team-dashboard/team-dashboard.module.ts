import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';

import { TeamDashboardController } from './team-dashboard.controller';
import { TEAM_DASHBOARD_QUEUE } from './team-dashboard.interface';
import {
  TeamDashboardProcessor,
  TeamDashboardScheduler,
} from './team-dashboard.processor';
import { TeamDashboardService } from './team-dashboard.service';

@Module({
  imports: [BullModule.registerQueue({ name: TEAM_DASHBOARD_QUEUE })],
  controllers: [TeamDashboardController],
  providers: [
    TeamDashboardService,
    TeamDashboardScheduler,
    TeamDashboardProcessor,
  ],
  exports: [TeamDashboardService],
})
export class TeamDashboardModule {}
