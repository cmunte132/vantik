import {
  Body,
  Controller,
  Delete,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ConnectIntegrationDto,
  IntegrationAccountIdDto,
  UpdateTeamMappingsDto,
} from '@vantikhq/types';

import { AuthGuard } from 'modules/auth/auth.guard';
import { UserId, Workspace } from 'modules/auth/session.decorator';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';

import { IntegrationAccountService } from './integration-account.service';

@Controller({
  version: '1',
  path: 'integration_account',
})
export class IntegrationAccountController {
  constructor(private integrationAccountService: IntegrationAccountService) {}

  /** Turn on an integration that declares `no_auth`. */
  @Post()
  @UseGuards(AuthGuard)
  async connect(
    @Body() connectIntegrationDto: ConnectIntegrationDto,
    @UserId() userId: string,
    @Workspace() workspaceId: string,
  ) {
    return await this.integrationAccountService.connect(
      connectIntegrationDto,
      userId,
      workspaceId,
    );
  }

  /** Which teams a workspace account routes work to. */
  @Post(':integrationAccountId/team_mappings')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async updateTeamMappings(
    @Param() integrationAccountIdDto: IntegrationAccountIdDto,
    @Body() updateTeamMappingsDto: UpdateTeamMappingsDto,
    @UserId() userId: string,
  ) {
    return await this.integrationAccountService.updateTeamMappings(
      integrationAccountIdDto,
      updateTeamMappingsDto,
      userId,
    );
  }

  /**
   * Disconnect an integration account.
   *
   * The guard proves the account is in the caller's workspace; the service
   * proves a personal account is the caller's own.
   */
  @Delete(':integrationAccountId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async deleteIntegrationAccount(
    @Param()
    integrationAccountIdRequestIdBody: IntegrationAccountIdDto,
    @UserId() userId: string,
  ) {
    return await this.integrationAccountService.deleteIntegrationAccount(
      integrationAccountIdRequestIdBody,
      userId,
    );
  }
}
