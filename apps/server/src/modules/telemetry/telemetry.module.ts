import { Module } from '@nestjs/common';

import { TelemetryThrottleGuard } from './telemetry-throttle.guard';
import { TelemetryController } from './telemetry.controller';

@Module({
  controllers: [TelemetryController],
  providers: [TelemetryThrottleGuard],
})
export class TelemetryModule {}
