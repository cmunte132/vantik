import { Module } from '@nestjs/common';
import { PrismaModule, PrismaService } from 'nestjs-prisma';

import { UsersService } from 'modules/users/users.service';

import { PromptSeeder } from './prompt.seeder';

@Module({
  imports: [PrismaModule],
  controllers: [],
  providers: [PrismaService, UsersService, PromptSeeder],
  exports: [],
})
export class PromptsModule {}
