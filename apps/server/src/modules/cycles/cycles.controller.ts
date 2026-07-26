import {
  Body,
  Controller,
  Delete,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CompleteCycleDto,
  CreateCycleDto,
  UpdateCycleDto,
} from '@vantikhq/types';

import { AuthGuard } from 'modules/auth/auth.guard';
import { UserId } from 'modules/auth/session.decorator';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';
import { AdminGuard } from 'modules/users/admin.guard';

import { CyclesService } from './cycles.service';

@Controller({
  version: '1',
  path: 'cycles',
})
export class CyclesController {
  constructor(private cycles: CyclesService) {}

  @Post()
  @UseGuards(AuthGuard, AdminGuard, WorkspaceResourceGuard)
  async createCycle(@Body('teamId') teamId: string) {
    return await this.cycles.createCycles(teamId);
  }

  /**
   * Declared above `:cycleId` — Nest matches in declaration order, and the
   * parameterised route would otherwise swallow every literal path below it and
   * treat the word as an id.
   */
  @Post('single')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async createSingleCycle(@Body() cycleData: CreateCycleDto) {
    return await this.cycles.createCycle(cycleData);
  }

  @Post(':cycleId/start')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async startCycle(@Param('cycleId') cycleId: string) {
    return await this.cycles.startCycle(cycleId);
  }

  @Post(':cycleId/complete')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async completeCycle(
    @Param('cycleId') cycleId: string,
    @Body() completeCycleDto: CompleteCycleDto,
    @UserId() userId: string,
  ) {
    return await this.cycles.completeCycle(cycleId, completeCycleDto, userId);
  }

  @Post(':cycleId')
  @UseGuards(AuthGuard, AdminGuard, WorkspaceResourceGuard)
  async updateCycle(
    @Param('cycleId') cycleId: string,
    @Body() cycleData: UpdateCycleDto,
  ) {
    return await this.cycles.updateCycleDates(cycleId, cycleData);
  }

  @Delete(':cycleId')
  @UseGuards(AuthGuard, AdminGuard, WorkspaceResourceGuard)
  async deleteCycle(@Param('cycleId') cycleId: string) {
    return await this.cycles.deleteCycle(cycleId);
  }
}
