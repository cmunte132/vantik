import { Module } from '@nestjs/common';

import { UsersService } from 'modules/users/users.service';

import { WebhookSubscriptionController } from './webhook-subscription.controller';
import WebhookSubscriptionService from './webhook-subscription.service';

@Module({
  controllers: [WebhookSubscriptionController],
  providers: [WebhookSubscriptionService, UsersService],
  exports: [WebhookSubscriptionService],
})
export class WebhookSubscriptionModule {}
