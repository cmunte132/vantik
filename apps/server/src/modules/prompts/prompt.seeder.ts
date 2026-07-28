import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { LoggerService } from 'modules/logger/logger.service';
import { promptsSeedData } from 'modules/workspaces/workspaces.interface';

/**
 * This class gives every workspace the prompt rows that this build ships.
 *
 * `WorkspacesService` writes the prompts once, when it makes a workspace. A
 * workspace made before a prompt existed therefore never gets that prompt, and
 * the feature behind it fails on a row that is not there. The module classifier
 * is the first prompt added after this product had workspaces, so it is the
 * first one to need this.
 *
 * The seed runs at each start of the server and is safe to repeat. It writes
 * each row by workspace and name together, which is the unique index.
 */
@Injectable()
export class PromptSeeder implements OnModuleInit {
  private readonly logger = new LoggerService(PromptSeeder.name);

  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    try {
      await this.seed();
    } catch (error) {
      // A failed seed must not stop the server. The usual cause is a database
      // with no migration yet, and the next start repairs it.
      this.logger.error({
        message: `The seed of the prompts failed: ${error}`,
        where: 'PromptSeeder.onModuleInit',
      });
    }
  }

  async seed() {
    const workspaces = await this.prisma.workspace.findMany({
      where: { deleted: null },
      select: { id: true },
    });

    for (const workspace of workspaces) {
      for (const seed of promptsSeedData) {
        await this.prisma.prompt.upsert({
          where: {
            name_workspaceId: { name: seed.name, workspaceId: workspace.id },
          },
          create: {
            name: seed.name,
            prompt: seed.prompt,
            model: seed.model,
            workspaceId: workspace.id,
          },
          // The text of a prompt is not overwritten. An operator can edit a
          // prompt for their workspace, and a restart must not undo that work.
          update: {},
        });
      }
    }

    this.logger.info({
      message: `Seeded ${promptsSeedData.length} prompt(s) for ${workspaces.length} workspace(s)`,
      where: 'PromptSeeder.seed',
    });
  }
}
