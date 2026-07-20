import { Injectable } from '@nestjs/common';
import {
  IntegrationDefinition,
  IntegrationDefinitionIdDto,
  IntegrationEventPayload,
  IntegrationPayloadEventType,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { resolveWorkspaceId } from 'common/workspace-access';

import { IntegrationsService } from 'modules/integrations/integrations.service';

import { IntegrationDefinitionUpdateBody } from './integration-definition.interface';

@Injectable()
export class IntegrationDefinitionService {
  constructor(
    private prisma: PrismaService,
    private integrations: IntegrationsService,
  ) {}

  async getIntegrationDefinitions(
    sessionWorkspaceId: string,
    userId: string,
    requestedWorkspaceId?: string,
  ): Promise<IntegrationDefinition[]> {
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      requestedWorkspaceId,
    );

    return await this.prisma.integrationDefinitionV2.findMany({
      where: {
        OR: [
          {
            workspaceId: null,
          },
          {
            workspaceId,
          },
        ],
      },
    });
  }

  async getIntegrationDefinitionWithId(
    integrationDefinitionRequestIdBody: IntegrationDefinitionIdDto,
  ): Promise<IntegrationDefinition> {
    return await this.prisma.integrationDefinitionV2.findUnique({
      where: { id: integrationDefinitionRequestIdBody.integrationDefinitionId },
    });
  }

  async getIntegrationDefinitionWithSpec(
    integrationDefinitionId: string,
  ): Promise<IntegrationDefinition> {
    const integrationDefinition = await this.getIntegrationDefinitionWithId({
      integrationDefinitionId,
    });

    const payload: IntegrationEventPayload = {
      event: IntegrationPayloadEventType.SPEC,
    };

    const spec = await this.integrations.loadIntegration(
      integrationDefinition.slug,
      payload,
    );

    return { ...integrationDefinition, spec };
  }

  async updateIntegrationDefinition(
    integrationDefinitionUpdateBody: IntegrationDefinitionUpdateBody,
    integrationDefinitionId: string,
  ) {
    integrationDefinitionUpdateBody;
    return await this.prisma.integrationDefinitionV2.update({
      data: integrationDefinitionUpdateBody,
      where: {
        id: integrationDefinitionId,
      },
    });
  }
}
