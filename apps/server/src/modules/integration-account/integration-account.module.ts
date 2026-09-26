import { Module } from '@nestjs/common';

import { IntegrationsModule } from 'modules/integrations/integrations.module';
import { UsersService } from 'modules/users/users.service';

import { IntegrationAccountController } from './integration-account.controller';
import { IntegrationAccountService } from './integration-account.service';

@Module({
  // IntegrationsModule to ask a plugin whether it connects without OAuth.
  imports: [IntegrationsModule],
  controllers: [IntegrationAccountController],
  // UsersService because AuthGuard resolves it from the module it guards.
  providers: [IntegrationAccountService, UsersService],
  exports: [IntegrationAccountService],
})
export class IntegrationAccountModule {}
