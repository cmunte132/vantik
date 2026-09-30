import { Module } from '@nestjs/common';

import { CachceModule } from 'modules/cache/cache.module';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [CachceModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
