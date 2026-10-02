import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Res,
  UnsupportedMediaTypeException,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';

import { LoggerService } from 'modules/logger/logger.service';

import { isRelayedSignal, relayTarget, sanitiseExport } from './otlp-relay';
import { TelemetryThrottleGuard } from './telemetry-throttle.guard';

/** How long the relay waits on the backend before it gives up. */
const RELAY_TIMEOUT_MS = 10_000;

/**
 * Status codes the OTel exporters retry on. The relay passes these through so
 * the browser backs off and retries. Every other failure is answered as a
 * success, because retrying a request the backend refused only repeats it.
 */
const RETRYABLE = new Set([429, 502, 503, 504]);

@Controller({
  version: '1',
  path: 'telemetry',
})
export class TelemetryController {
  private readonly logger = new LoggerService('TelemetryRelay');

  /**
   * Accepts an OTLP/JSON export from the browser and forwards it to the
   * server's own OTLP endpoint. See otlp-relay.ts for why the browser never
   * talks to the backend itself.
   *
   * Deliberately unauthenticated: the page reports load errors and timings
   * before anybody has signed in. The body size cap (in main.ts), the shape
   * check and the address rate limit are what stand in for a session.
   *
   * With no endpoint configured the export is accepted and discarded, so a
   * browser that started its SDK before the operator turned telemetry off does
   * not retry forever.
   */
  @Post(':signal')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TelemetryThrottleGuard)
  async relay(
    @Param('signal') signal: string,
    @Headers('content-type') contentType: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, never>> {
    if (!isRelayedSignal(signal)) {
      throw new NotFoundException();
    }

    if (!contentType?.toLowerCase().startsWith('application/json')) {
      throw new UnsupportedMediaTypeException('Send OTLP/JSON');
    }

    const target = relayTarget(signal);
    if (!target) {
      return {};
    }

    const payload = sanitiseExport(signal, body);
    if (!payload) {
      throw new BadRequestException('Not an OTLP export request');
    }

    try {
      const upstream = await fetch(target.url, {
        method: 'POST',
        headers: { ...target.headers, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });

      if (RETRYABLE.has(upstream.status)) {
        res.status(upstream.status);
      } else if (!upstream.ok) {
        // A refusal is the operator's misconfiguration, not the browser's, so
        // it goes in the server log where the operator looks.
        this.logger.warn({
          message: `OTLP backend refused browser ${signal}: ${upstream.status}`,
          where: 'TelemetryController.relay',
        });
      }
    } catch (error) {
      this.logger.warn({
        message: `OTLP backend unreachable for browser ${signal}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        where: 'TelemetryController.relay',
      });
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }

    return {};
  }
}
