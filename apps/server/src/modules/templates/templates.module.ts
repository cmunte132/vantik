import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { UsersService } from 'modules/users/users.service';

import { TemplatesController } from './templates.controller';
import TemplatesService from './templates.service';

@Module({
  imports: [HttpModule],
  controllers: [TemplatesController],
  providers: [TemplatesService, UsersService],
  exports: [TemplatesService],
})
export class TemplatesModule {}
