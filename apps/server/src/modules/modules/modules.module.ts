import { Module } from '@nestjs/common';
import { PrismaModule } from 'nestjs-prisma';

import { UsersService } from 'modules/users/users.service';

import { ModulesController } from './modules.controller';
import { ModulesService } from './modules.service';

@Module({
  imports: [PrismaModule],
  controllers: [ModulesController],
  providers: [ModulesService, UsersService],
  exports: [ModulesService],
})
export class ModulesModule {}
