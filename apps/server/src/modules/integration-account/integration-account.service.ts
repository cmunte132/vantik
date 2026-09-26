import { Injectable, NotFoundException } from '@nestjs/common';
import { IntegrationAccountIdDto } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

@Injectable()
export class IntegrationAccountService {
  constructor(private prisma: PrismaService) {}

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
      include: {
        integrationDefinition: true,
        workspace: true,
      },
    });
  }
}
