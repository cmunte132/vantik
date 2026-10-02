import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerOptions } from '@nestjs/throttler';

/** Exports one address may relay per window before it gets 429s. */
export const DEFAULT_TELEMETRY_RATE_LIMIT = 600;

/** Length of that window, in milliseconds. */
export const DEFAULT_TELEMETRY_RATE_WINDOW_MS = 60_000;

/**
 * `TELEMETRY_RATE_LIMIT=0` turns the limit off, for an operator who fronts the
 * server with their own limiter. As for MCP, a zero limit has to skip the check,
 * because the throttler reads zero as "reject everything".
 */
export function telemetryThrottlerOptions(): ThrottlerOptions {
  const limit = readNumber(
    process.env.TELEMETRY_RATE_LIMIT,
    DEFAULT_TELEMETRY_RATE_LIMIT,
  );
  const ttl = readNumber(
    process.env.TELEMETRY_RATE_LIMIT_WINDOW_MS,
    DEFAULT_TELEMETRY_RATE_WINDOW_MS,
  );

  return { name: 'telemetry', limit, ttl, skipIf: () => limit === 0 };
}

function readNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Rate limits the browser telemetry relay by address.
 *
 * The relay is unauthenticated, so the address is the only thing to count. A
 * tab exports a batch every few seconds per signal, which is well under the
 * default. The limit is there to stop a script from using the relay to flood
 * the operator's backend, which may bill by volume.
 *
 * The server does not set `trust proxy`, so behind the webapp's nginx every
 * browser shares one address. The default is generous for that reason. Raise
 * it, or set it to 0, on a large install.
 */
@Injectable()
export class TelemetryThrottleGuard extends ThrottlerGuard {
  /**
   * ThrottlerModule is global, and its app-wide 10-per-minute budget would win
   * over a second registration, as McpThrottleGuard found. Replacing the
   * resolved throttlers is what applies this budget.
   */
  async onModuleInit() {
    await super.onModuleInit();
    this.throttlers = [telemetryThrottlerOptions()];
  }
}
