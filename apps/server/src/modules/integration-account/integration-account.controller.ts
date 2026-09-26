import { Controller, Delete, Param, UseGuards } from '@nestjs/common';
import { IntegrationAccountIdDto } from '@vantikhq/types';

import { AuthGuard } from 'modules/auth/auth.guard';

import { IntegrationAccountService } from './integration-account.service';

@Controller({
  version: '1',
  path: 'integration_account',
})
export class IntegrationAccountController {
  constructor(private integrationAccountService: IntegrationAccountService) {}

  /**
   * Delete a Integration account
   */
  @Delete(':integrationAccountId')
  @UseGuards(AuthGuard)
  async deleteIntegrationAccount(
    @Param()
    integrationAccountIdRequestIdBody: IntegrationAccountIdDto,
  ) {
    return await this.integrationAccountService.deleteIntegrationAccount(
      integrationAccountIdRequestIdBody,
    );
  }
}
