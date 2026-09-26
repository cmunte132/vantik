import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ConnectIntegrationDto,
  IntegrationAccountIdDto,
  IntegrationPayloadEventType,
  TeamMapping,
  UpdateTeamMappingsDto,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { assertTeamsVisible, visibleTeamIds } from 'common/team-access';
import { resolveWorkspaceId } from 'common/workspace-access';

import { IntegrationsService } from 'modules/integrations/integrations.service';

/**
 * What a response about an account may carry. The row holds the vendor's
 * tokens in `integrationConfiguration`, and a definition holds the client
 * secret, so neither is ever included.
 */
const ACCOUNT_VIEW = {
  id: true,
  accountId: true,
  settings: true,
  personal: true,
  workspaceId: true,
  integrationDefinitionId: true,
} as const;

@Injectable()
export class IntegrationAccountService {
  constructor(
    private prisma: PrismaService,
    private integrations: IntegrationsService,
  ) {}

  /**
   * Turn on an integration that has nobody to authorise.
   *
   * An integration acts for a workspace only once the workspace has an account
   * for it; for GitHub that account is what OAuth leaves behind. One that
   * declares `no_auth` — the Bug Enricher, which talks to no vendor — gets its
   * account here instead, one per workspace, keyed by the workspace itself.
   */
  async connect(
    { integrationDefinitionId, workspaceId: requested }: ConnectIntegrationDto,
    userId: string,
    sessionWorkspaceId: string,
  ) {
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      requested,
    );

    const definition = await this.prisma.integrationDefinitionV2.findFirst({
      where: {
        id: integrationDefinitionId,
        deleted: null,
        OR: [{ workspaceId: null }, { workspaceId }],
      },
      select: { id: true, slug: true },
    });

    const spec = definition
      ? await this.integrations.loadIntegration(definition.slug, {
          event: IntegrationPayloadEventType.SPEC,
        })
      : undefined;

    // An OAuth integration made this way would be an account with no
    // credential, which every vendor call would then fail on.
    if (!definition || !spec?.no_auth) {
      throw new NotFoundException({
        message: `No integration ${integrationDefinitionId} connects without authorisation`,
      });
    }

    return await this.prisma.integrationAccount.upsert({
      where: {
        accountId_integrationDefinitionId_workspaceId: {
          accountId: workspaceId,
          integrationDefinitionId: definition.id,
          workspaceId,
        },
      },
      create: {
        accountId: workspaceId,
        integrationDefinitionId: definition.id,
        workspaceId,
        integratedById: userId,
        personal: false,
        isActive: true,
        integrationConfiguration: {},
        settings: {},
      },
      update: { deleted: null, isActive: true },
      select: ACCOUNT_VIEW,
    });
  }

  /**
   * Replace which teams a workspace account routes work to.
   *
   * The caller may add or remove a pair only for a team they are in: a pair
   * decides where issues land, and a GitHub mapping pushes a team's issues to
   * a repository, so pairing a team you cannot see would publish it. A pair
   * that is kept as it was is not re-checked — a teammate's mapping for their
   * own team survives your edit of yours.
   */
  async updateTeamMappings(
    { integrationAccountId }: IntegrationAccountIdDto,
    { teamMappings }: UpdateTeamMappingsDto,
    userId: string,
  ) {
    const account = await this.prisma.integrationAccount.findFirst({
      where: { id: integrationAccountId, deleted: null },
      select: { personal: true, settings: true, workspaceId: true },
    });

    // A personal account is somebody's own identity on the vendor, and routes
    // nothing to anyone.
    if (!account || account.personal) {
      throw new NotFoundException({
        message: `Integration account ${integrationAccountId} not found`,
      });
    }

    const settings = (account.settings ?? {}) as Record<string, unknown>;
    const current = (settings.teamMappings ?? []) as TeamMapping[];

    const keyOf = ({ source, teamId }: TeamMapping) => `${source}\n${teamId}`;
    const next = [
      ...new Map(
        teamMappings.map(({ source, teamId }) => [
          keyOf({ source, teamId }),
          { source, teamId },
        ]),
      ).values(),
    ];

    const before = new Set(current.map(keyOf));
    const after = new Set(next.map(keyOf));
    const touched = [
      ...next.filter((pair) => !before.has(keyOf(pair))),
      ...current.filter((pair) => !after.has(keyOf(pair))),
    ].map((pair) => pair.teamId);

    await assertTeamsVisible(
      touched,
      await visibleTeamIds(this.prisma, userId, account.workspaceId),
    );

    return await this.prisma.integrationAccount.update({
      where: { id: integrationAccountId },
      data: { settings: { ...settings, teamMappings: next } },
      select: ACCOUNT_VIEW,
    });
  }

  /**
   * A workspace account is anyone's in the workspace to disconnect. A personal
   * one belongs to the person who connected it: it acts as them on the vendor,
   * so a teammate removing it would change whose name their comments go out
   * under. Refused as not found, the same answer as a foreign id.
   */
  async deleteIntegrationAccount(
    { integrationAccountId }: IntegrationAccountIdDto,
    userId: string,
  ) {
    const account = await this.prisma.integrationAccount.findFirst({
      where: { id: integrationAccountId, deleted: null },
      select: { personal: true, integratedById: true },
    });

    if (!account || (account.personal && account.integratedById !== userId)) {
      throw new NotFoundException({
        message: `Integration account ${integrationAccountId} not found`,
      });
    }

    return await this.prisma.integrationAccount.update({
      where: { id: integrationAccountId },
      data: {
        deleted: new Date().toISOString(),
        isActive: false,
      },
      select: ACCOUNT_VIEW,
    });
  }
}
