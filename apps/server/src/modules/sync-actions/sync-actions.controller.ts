import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { AuthGuard } from 'modules/auth/auth.guard';
import { UserId, Workspace } from 'modules/auth/session.decorator';

import {
  BootstrapRequestQuery,
  DeltaRequestQuery,
} from './sync-actions.interface';
import SyncActionsService from './sync-actions.service';

@Controller({
  version: '1',
  path: 'sync_actions',
})
export class SyncActionsController {
  constructor(private syncActionsService: SyncActionsService) {}

  @Get('bootstrap')
  @UseGuards(AuthGuard)
  async getBootstrap(
    @Workspace() workspaceId: string,
    @UserId() userId: string,
    @Query() bootstrapQuery: BootstrapRequestQuery,
  ) {
    return await this.syncActionsService.getBootstrap(
      bootstrapQuery.modelNames,
      workspaceId,
      userId,
      bootstrapQuery.workspaceId,
    );
  }

  @Get('delta')
  @UseGuards(AuthGuard)
  async getDelta(
    @Workspace() workspaceId: string,
    @UserId() userId: string,
    @Query() deltaQuery: DeltaRequestQuery,
  ) {
    return await this.syncActionsService.getDelta(
      deltaQuery.modelNames,
      BigInt(deltaQuery.lastSequenceId),
      workspaceId,
      userId,
      deltaQuery.workspaceId,
    );
  }
}
