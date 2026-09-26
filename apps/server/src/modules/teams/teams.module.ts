import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { SyncModule } from 'modules/sync/sync.module';
import { UsersService } from 'modules/users/users.service';

import { TeamsController } from './teams.controller';
import TeamsService from './teams.service';

@Module({
  imports: [HttpModule, SyncModule],
  controllers: [TeamsController],
  providers: [TeamsService, UsersService],
  exports: [TeamsService],
})
export class TeamsModule {}
