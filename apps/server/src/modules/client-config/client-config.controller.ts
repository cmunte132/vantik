import { Controller, Get } from '@nestjs/common';

import ClientConfigService, { ClientConfig } from './client-config.service';

@Controller({
  version: '1',
  path: 'config',
})
export class ClientConfigController {
  constructor(private clientConfigService: ClientConfigService) {}

  // Deliberately unauthenticated: the browser reads this before it has a
  // session, and everything it returns is public.
  @Get()
  getClientConfig(): ClientConfig {
    return this.clientConfigService.getClientConfig();
  }
}
