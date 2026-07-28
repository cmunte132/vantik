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
import { integrationSeeds } from './integration-definition.seed';

/**
 * This function removes the secrets of a definition before it leaves the
 * server.
 *
 * The `clientSecret` and `config` columns hold the credentials of the whole
 * deployment. A member of a workspace has no use for them, so a response to
 * the browser carries a boolean in their place.
 */
export function toPublicDefinition(
  definition: IntegrationDefinition,
): IntegrationDefinition {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { clientSecret, config, ...rest } = definition;

  const seed = integrationSeeds.find((entry) => entry.slug === definition.slug);

  // An integration that has no pair of environment variables needs no
  // credentials. The local repository integration is one of them, and it is
  // ready as soon as its row exists.
  const configured = seed?.credentialEnv
    ? Boolean(definition.clientId && clientSecret)
    : true;

  return {
    ...rest,
    configured,
    credentialEnv: seed?.credentialEnv,
  } as IntegrationDefinition;
}

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
