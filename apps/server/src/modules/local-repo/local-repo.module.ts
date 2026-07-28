import { Module } from '@nestjs/common';
import { PrismaModule, PrismaService } from 'nestjs-prisma';

import { UsersService } from 'modules/users/users.service';

import { LocalRepoController } from './local-repo.controller';
import { LocalRepoService } from './local-repo.service';

@Module({
  imports: [PrismaModule],
  controllers: [LocalRepoController],
  providers: [PrismaService, LocalRepoService, UsersService],
  exports: [LocalRepoService],
})
export class LocalRepoModule {}
