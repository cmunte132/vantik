import { Controller, Get } from '@nestjs/common';

import { AppService, ServerInfo } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  // Root doubles as a liveness/health endpoint for docker/k8s probes.
  @Get()
  getInfo(): ServerInfo {
    return this.appService.getInfo();
  }
}
