import { Module } from '@nestjs/common';
import { PrismaModule } from 'nestjs-prisma';

import { UsersService } from 'modules/users/users.service';

import { CapabilitiesController } from './capabilities.controller';
import { CapabilitiesService } from './capabilities.service';

@Module({
  imports: [PrismaModule],
  controllers: [CapabilitiesController],
  providers: [CapabilitiesService, UsersService],
  exports: [CapabilitiesService],
})
export class CapabilitiesModule {}
