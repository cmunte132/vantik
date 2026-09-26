import { Controller, Delete, Param, UseGuards } from '@nestjs/common';
import { IntegrationAccountIdDto } from '@vantikhq/types';

import { AuthGuard } from 'modules/auth/auth.guard';
import { UserId } from 'modules/auth/session.decorator';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';

import { IntegrationAccountService } from './integration-account.service';

@Controller({
  version: '1',
  path: 'integration_account',
})
export class IntegrationAccountController {
  constructor(private integrationAccountService: IntegrationAccountService) {}

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
