import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { LoggerService } from 'modules/logger/logger.service';

import {
  integrationSeeds,
  readSeedCredentials,
} from './integration-definition.seed';

/**
 * This class writes one row for each integration that the deployment ships.
 *
 * The integrations page was empty before this class existed. The code of five
 * integrations was in the repository, but no row named any of them, and the
 * page shows only the rows. Nothing in the product made a row, and the
 * controller has no route that makes one.
 *
 * The seed runs at each start of the server. It is safe to repeat, because it
 * writes each row by its unique name. A new workspace needs no seed of its
 * own: each row is global, and the list query gives a global row to every
 * workspace.
 */
@Injectable()
export class IntegrationDefinitionSeeder implements OnModuleInit {
  private readonly logger = new LoggerService(IntegrationDefinitionSeeder.name);

  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    try {
      await this.seed();
    } catch (error) {
      // A failed seed must not stop the server. The most common cause is a
      // database that has no migration yet, and the next start repairs it.
      this.logger.error({
        message: `The seed of the integration definitions failed: ${error}`,
        where: 'IntegrationDefinitionSeeder.onModuleInit',
      });
    }
  }

  async seed() {
    for (const seed of integrationSeeds) {
      const credentials = readSeedCredentials(seed);

      await this.prisma.integrationDefinitionV2.upsert({
        where: { name: seed.name },
        create: {
          name: seed.name,
          slug: seed.slug,
          description: seed.description,
          icon: seed.icon,
          // The environment of this deployment holds the credentials. If it
          // holds none, the row is still correct, and the settings page tells
          // the operator which two variables to set.
          clientId: credentials?.clientId ?? '',
          clientSecret: credentials?.clientSecret ?? '',
          workspaceId: null,
        },
        update: {
          slug: seed.slug,
          description: seed.description,
          icon: seed.icon,
          // The environment is the authority on a credential that it holds.
          // For a credential that it does not hold, the row keeps the value it
          // has. An operator can set a credential through the update route,
          // and a restart must not remove that work. `readSeedCredentials`
          // therefore gives a field only for a variable that is set, and this
          // spread then names only the columns that the environment supplies.
          ...(credentials ?? {}),
          deleted: null,
        },
      });
    }

    this.logger.info({
      message: `The integrations page has ${integrationSeeds.length} definitions`,
      where: 'IntegrationDefinitionSeeder.seed',
    });
  }
}
