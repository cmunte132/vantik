import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import * as bodyParser from 'body-parser';
import { PrismaClientExceptionFilter } from 'nestjs-prisma';
import supertokens from 'supertokens-node';

import type { CorsConfig } from 'common/configs/config.interface';

import { SupertokensExceptionFilter } from 'modules/auth/auth.filter';
import { LoggerService } from 'modules/logger/logger.service';
import ReplicationService from 'modules/replication/replication.service';
import { TriggerdevService } from 'modules/triggerdev/triggerdev.service';

import { AppModule } from './app.module';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

// Several services fire-and-forget calls to optional integrations
// (trigger.dev, ollama, SMTP). A rejected promise from one of those must not
// take down the whole server, so log instead of crashing.
process.on('unhandledRejection', (reason) => {
  new LoggerService('UnhandledRejection').error({
    message: `Unhandled promise rejection: ${reason instanceof Error ? reason.message : reason}`,
    where: 'process.unhandledRejection',
  });
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new LoggerService('Vantik'),
  });

  // Validation
  app.useGlobalPipes(new ValidationPipe({}));

  app.use(bodyParser.json({ limit: '50mb' })); // Adjust limit as required

  // Initiate trigger service
  const triggerService = app.get(TriggerdevService);
  triggerService.initCommonProject();

  // Initiate replication service
  const replicationService = app.get(ReplicationService);
  replicationService.init();

  // enable shutdown hook
  app.enableShutdownHooks();

  // Prisma Client Exception Filter for unhandled exceptions
  const { httpAdapter } = app.get(HttpAdapterHost);
  app.useGlobalFilters(
    new PrismaClientExceptionFilter(httpAdapter),
    new SupertokensExceptionFilter(),
  );

  const configService = app.get(ConfigService);
  const corsConfig = configService.get<CorsConfig>('cors');

  // Versioning
  app.enableVersioning({
    type: VersioningType.URI,
  });

  // Cors
  if (corsConfig.enabled) {
    app.enableCors({
      origin: configService.get('FRONTEND_HOST').split(',') || '',
      allowedHeaders: ['content-type', ...supertokens.getAllCORSHeaders()],
      credentials: true,
    });
  }

  await app.listen(process.env.PORT || 3001);
}
bootstrap().catch((error) => {
  // A failed boot must exit (rather than linger half-initialised) so the
  // container restart policy can retry it.
  new LoggerService('Bootstrap').error({
    message: `Fatal error during bootstrap: ${error instanceof Error ? error.stack : error}`,
    where: 'bootstrap',
  });
  process.exit(1);
});
