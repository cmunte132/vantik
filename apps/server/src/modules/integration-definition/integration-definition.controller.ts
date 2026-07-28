import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  IntegrationDefinition,
  IntegrationDefinitionIdDto,
} from '@vantikhq/types';

import { AuthGuard } from 'modules/auth/auth.guard';
import { UserId, Workspace } from 'modules/auth/session.decorator';

import {
  IntegrationDefinitionListQuery,
  IntegrationDefinitionUpdateBody,
} from './integration-definition.interface';
import {
  IntegrationDefinitionService,
  toPublicDefinition,
} from './integration-definition.service';

@Controller({
  version: '1',
  path: 'integration_definition',
})
export class IntegrationDefinitionController {
  constructor(
    private integrationDefinitionService: IntegrationDefinitionService,
  ) {}

  /**
   * Get all integration definitions in a workspace
   */
  @Get()
  @UseGuards(AuthGuard)
  async getIntegrationDefinitionsByWorkspace(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Query()
    workspaceDto: IntegrationDefinitionListQuery,
  ) {
    const definitions =
      await this.integrationDefinitionService.getIntegrationDefinitions(
        sessionWorkspaceId,
        userId,
        workspaceDto.workspaceId,
      );

    return definitions.map(toPublicDefinition);
  }

  // /**
  //  * Get integration definition
  //  */
  @Get(':integrationDefinitionId')
  @UseGuards(AuthGuard)
  async getIntegrationDefinition(
    @Param()
    integrationDefinitionRequestIdBody: IntegrationDefinitionIdDto,
  ) {
    const definition =
      await this.integrationDefinitionService.getIntegrationDefinitionWithSpec(
        integrationDefinitionRequestIdBody.integrationDefinitionId,
      );

    return toPublicDefinition(definition);
  }

  // /**
  //  * Get spec for integration definition
  //  */
  @Get(':integrationDefinitionId/spec')
  @UseGuards(AuthGuard)
  async getIntegrationDefinitionSpec(
    @Param()
    integrationDefinitionRequestIdBody: IntegrationDefinitionIdDto,
  ) {
    const integrationDefinition =
      await this.integrationDefinitionService.getIntegrationDefinitionWithSpec(
        integrationDefinitionRequestIdBody.integrationDefinitionId,
      );

    return integrationDefinition.spec;
  }

  /**
   * Update a integration definition in a workspace
   *
   * This route writes `clientId`, `clientSecret` and `config` on a row that is
   * global to the deployment. It had no guard, and the two other routes of
   * this controller have one, so any caller on the network could replace the
   * OAuth credentials of every integration. That was of no consequence while
   * each row was empty. The seed puts real credentials in these rows.
   */
  @Post(':integrationDefinitionId')
  @UseGuards(AuthGuard)
  async updateIntegrationDefinition(
    @Param()
    integrationDefinitionRequestIdBody: IntegrationDefinitionIdDto,
    @Body()
    integrationDefinitionUpdateBody: IntegrationDefinitionUpdateBody,
  ): Promise<IntegrationDefinition> {
    const definition =
      await this.integrationDefinitionService.updateIntegrationDefinition(
        integrationDefinitionUpdateBody,
        integrationDefinitionRequestIdBody.integrationDefinitionId,
      );

    return toPublicDefinition(definition);
  }
}
