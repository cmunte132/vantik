import { Injectable } from '@nestjs/common';
import { IntegrationAccountIdDto } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

@Injectable()
export class IntegrationAccountService {
  constructor(private prisma: PrismaService) {}

  async deleteIntegrationAccount(
    integrationAccountRequestIdBody: IntegrationAccountIdDto,
  ) {
    return await this.prisma.integrationAccount.update({
      where: {
        id: integrationAccountRequestIdBody.integrationAccountId,
      },
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
