import { Module } from '@nestjs/common';

import { UsersService } from 'modules/users/users.service';

import { ViewsController } from './views.controller';
import { ViewsService } from './views.service';

@Module({
  controllers: [ViewsController],
  providers: [ViewsService, UsersService],
  exports: [ViewsService],
})
export class ViewsModule {}
