import { Module } from '@nestjs/common';

import { UsersService } from 'modules/users/users.service';

import { CapabilitiesController } from './capabilities.controller';
import { CapabilitiesService } from './capabilities.service';

@Module({
  controllers: [CapabilitiesController],
  providers: [CapabilitiesService, UsersService],
  exports: [CapabilitiesService],
})
export class CapabilitiesModule {}
