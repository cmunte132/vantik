import { Module } from '@nestjs/common';

import { IntegrationDefinitionModule } from 'modules/integration-definition/integration-definition.module';
import { UsersService } from 'modules/users/users.service';

import { IntegrationAccountController } from './integration-account.controller';
import { IntegrationAccountService } from './integration-account.service';

@Module({
  imports: [IntegrationDefinitionModule],
  controllers: [IntegrationAccountController],
  providers: [IntegrationAccountService, UsersService],
  exports: [IntegrationAccountService],
})
export class IntegrationAccountModule {}
