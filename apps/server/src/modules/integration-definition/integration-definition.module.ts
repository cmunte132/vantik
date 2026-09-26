import { Module } from '@nestjs/common';

import { IntegrationsModule } from 'modules/integrations/integrations.module';
import { UsersService } from 'modules/users/users.service';

import { IntegrationDefinitionController } from './integration-definition.controller';
import { IntegrationDefinitionSeeder } from './integration-definition.seeder';
import { IntegrationDefinitionService } from './integration-definition.service';

@Module({
  imports: [IntegrationsModule],
  controllers: [IntegrationDefinitionController],
  providers: [
    IntegrationDefinitionService,
    IntegrationDefinitionSeeder,
    UsersService,
  ],
  exports: [IntegrationDefinitionService],
})
export class IntegrationDefinitionModule {}
