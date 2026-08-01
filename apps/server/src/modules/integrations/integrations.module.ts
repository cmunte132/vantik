import { Module } from '@nestjs/common';

// import { DiscordBotService } from './discord-bot.service';
import { UsersService } from 'modules/users/users.service';
import { PluginsModule } from 'plugins/plugins.module';

import { DiscordBotService } from './discord-bot.service';
import { IntegrationsService } from './integrations.service';

@Module({
  // PluginsModule supplies the context every integration is now handed.
  imports: [PluginsModule],
  controllers: [],
  providers: [IntegrationsService, DiscordBotService, UsersService],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
