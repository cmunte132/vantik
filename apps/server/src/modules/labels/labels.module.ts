import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { UsersService } from 'modules/users/users.service';

import { LabelsController } from './labels.controller';
import LabelsService from './labels.service';

@Module({
  imports: [HttpModule],
  controllers: [LabelsController],
  providers: [LabelsService, UsersService],
  exports: [LabelsService],
})
export class LabelsModule {}
