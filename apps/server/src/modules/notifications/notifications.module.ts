import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { PrismaModule, PrismaService } from 'nestjs-prisma';

import { UsersService } from 'modules/users/users.service';

import { NotificationsController } from './notifications.controller';
import { NOTIFICATIONS_QUEUE } from './notifications.interface';
import { NotificationsProcessor } from './notifications.processor';
import { NotificationsQueue } from './notifications.queue';
import NotificationsService from './notifications.service';

@Module({
  imports: [
    PrismaModule,
    HttpModule,
    BullModule.registerQueue({ name: NOTIFICATIONS_QUEUE }),
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsQueue,
    NotificationsProcessor,
    PrismaService,
    UsersService,
  ],
  // `NotificationsQueue` is exported because the services that notice
  // something worth notifying about live in other modules — issues, comments
  // and relations. Delivery stays here; only the enqueue crosses the boundary.
  exports: [NotificationsService, NotificationsQueue],
})
export class NotificationsModule {}
