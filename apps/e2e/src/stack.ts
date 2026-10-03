import { expect, type APIRequestContext } from '@playwright/test';

import { MAILPIT_URL, SERVER_URL, WEBAPP_URL } from './env';

/** Status of a GET, or 0 while nothing is listening yet. */
async function statusOf(request: APIRequestContext, url: string) {
  try {
    return (await request.get(url, { timeout: 5_000 })).status();
  } catch {
    return 0;
  }
}

/**
 * Waits until the server, the webapp and Mailpit all answer. The server
 * answers 503 on /health/ready until every dependency answers, which is the
 * same check the compose healthcheck gates the webapp on.
 */
export async function waitForStack(request: APIRequestContext) {
  await expect
    .poll(() => statusOf(request, `${SERVER_URL}/health/ready`), {
      message: `server at ${SERVER_URL} never became ready`,
      timeout: 180_000,
      intervals: [1_000, 2_000, 5_000],
    })
    .toBe(200);

  await expect
    .poll(() => statusOf(request, `${WEBAPP_URL}/api/version`), {
      message: `webapp at ${WEBAPP_URL} never answered`,
      timeout: 60_000,
    })
    .toBe(200);

  await expect
    .poll(() => statusOf(request, `${MAILPIT_URL}/api/v1/messages?limit=1`), {
      message:
        `Mailpit at ${MAILPIT_URL} never answered. Start the stack with ` +
        `docker-compose.e2e.yaml, which adds it.`,
      timeout: 30_000,
    })
    .toBe(200);
}
