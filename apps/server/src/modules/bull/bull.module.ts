import { BullModule } from '@nestjs/bull';
import { Global, Module } from '@nestjs/common';

// This import patches Bull. Nest must start the processors after the patch,
// so that each job gets a span and metrics. See bull-telemetry.ts.
import './bull-telemetry';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => ({
        redis: {
          host: process.env.REDIS_URL,
          port: Number(process.env.REDIS_PORT),
        },
      }),
    }),
  ],
  exports: [BullModule],
})
export class BullConfigModule {}
