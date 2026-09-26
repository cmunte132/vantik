import { BullModule } from '@nestjs/bull';
import { Global, Module } from '@nestjs/common';

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
