import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import {
  StateThreshold,
  StuckIssuesResponse,
  TeamDashboardMetrics,
  UpdateThresholdOverridesDto,
} from '@vantikhq/types';

import { AuthGuard } from 'modules/auth/auth.guard';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';

import { TeamDashboardService } from './team-dashboard.service';

/**
 * WorkspaceResourceGuard reads `:teamId` from the path. It checks that the team
 * is in the caller's workspace and that the caller can see the team.
 */
@Controller({
  version: '1',
  path: 'teams/:teamId/dashboard',
})
@UseGuards(AuthGuard, WorkspaceResourceGuard)
export class TeamDashboardController {
  constructor(private dashboard: TeamDashboardService) {}

  @Get('metrics')
  async getMetrics(
    @Param('teamId') teamId: string,
  ): Promise<TeamDashboardMetrics> {
    return await this.dashboard.getMetrics(teamId);
  }

  @Get('thresholds')
  async getThresholds(
    @Param('teamId') teamId: string,
  ): Promise<StateThreshold[]> {
    return await this.dashboard.getThresholds(teamId);
  }

  @Put('thresholds/overrides')
  async setOverrides(
    @Param('teamId') teamId: string,
    @Body() body: UpdateThresholdOverridesDto,
  ): Promise<StateThreshold[]> {
    return await this.dashboard.setOverrides(teamId, body.overrides);
  }

  @Get('stuck')
  async getStuck(
    @Param('teamId') teamId: string,
  ): Promise<StuckIssuesResponse> {
    return await this.dashboard.getStuckWithFindings(teamId);
  }
}
