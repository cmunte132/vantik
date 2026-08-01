import { Module } from '@nestjs/common';
import { PrismaModule, PrismaService } from 'nestjs-prisma';

import { UsersService } from 'modules/users/users.service';
import { PluginsModule } from 'plugins/plugins.module';

import { LocalRepoController } from './local-repo.controller';
import { LocalRepoService } from './local-repo.service';

@Module({
  // PluginsModule because the local-repo functions take a plugin context now,
  // and this service calls them directly rather than through the loader.
  imports: [PrismaModule, PluginsModule],
  controllers: [LocalRepoController],
  providers: [PrismaService, LocalRepoService, UsersService],
  exports: [LocalRepoService],
})
export class LocalRepoModule {}
