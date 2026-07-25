import { Module } from '@nestjs/common';
import { PrismaModule } from 'nestjs-prisma';

import { CachceModule } from 'modules/cache/cache.module';
import { VectorModule } from 'modules/vector/vector.module';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [PrismaModule, CachceModule, VectorModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
