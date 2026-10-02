// MUST be first: many modules read their settings the moment they are
// imported, the OpenTelemetry setup below among them. See src/env.ts.
import './env';
// MUST be next. OpenTelemetry patches modules as they are required, so
// anything imported above this line runs uninstrumented. See src/otel.ts.
import './otel';

import { VersioningType } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import * as bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import { Request, Response, NextFunction } from 'express';
import { PrismaClientExceptionFilter } from 'nestjs-prisma';
import { validationPipe } from 'common/validation';

import {
  LOCAL_ATTACHMENT_PATH,
  localAttachmentBodyParser,
} from 'modules/attachments/attachments.middleware';
import { LoggerService } from 'modules/logger/logger.service';
import ReplicationService from 'modules/replication/replication.service';

import { AppModule } from './app.module';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

// Several services fire-and-forget calls to optional integrations
// (ollama, SMTP). A rejected promise from one of those must not
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
  app.useGlobalPipes(validationPipe());
  app.use(cookieParser());
  // Origin check on mutating requests (CSRF protection)
  app.use((req: Request, res: Response, next: NextFunction) => {
    const method = req.method.toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const origin = req.headers['origin'];
      if (origin) {
        const allowedOrigins = (process.env.FRONTEND_HOST || 'http://localhost:3000')
          .split(',')
          .map((h) => h.trim().replace(/\/+$/, ''));
        if (!allowedOrigins.includes(origin)) {
          res.status(403).json({ message: 'Forbidden: invalid origin' });
          return;
        }
      }
    }
    next();
  });
  // Browser telemetry is relayed unauthenticated, so it gets a small cap of its
  // own. It parses first, and the general parser below then skips the body.
  app.use('/v1/telemetry', bodyParser.json({ limit: '1mb' }));
  app.use(bodyParser.json({ limit: '50mb' })); // Adjust limit as required

  app.use(LOCAL_ATTACHMENT_PATH, localAttachmentBodyParser());

  // Initiate replication service
  const replicationService = app.get(ReplicationService);
  replicationService.init();

  // enable shutdown hook
  app.enableShutdownHooks();

  // Prisma Client Exception Filter for unhandled exceptions
  const { httpAdapter } = app.get(HttpAdapterHost);
  app.useGlobalFilters(
    new PrismaClientExceptionFilter(httpAdapter),
  );

  // Versioning
  app.enableVersioning({
    type: VersioningType.URI,
  });

  app.enableCors({
    origin: process.env.FRONTEND_HOST.split(','),
    allowedHeaders: ['content-type', 'authorization', 'x-request-id', 'rid', 'st-auth-mode'],
    credentials: true,
  });

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
