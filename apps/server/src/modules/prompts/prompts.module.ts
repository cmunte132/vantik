import { Module } from '@nestjs/common';

import { UsersService } from 'modules/users/users.service';

import { PromptSeeder } from './prompt.seeder';

@Module({
  controllers: [],
  providers: [UsersService, PromptSeeder],
  exports: [],
})
export class PromptsModule {}
