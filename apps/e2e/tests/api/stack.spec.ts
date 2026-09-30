import { expect, test } from '../../src/fixtures';
import { SERVER_URL, WEBAPP_URL } from '../../src/env';

/**
 * Does the stack a self-hoster starts actually serve? Each of these has broken
 * on main with typecheck and every unit test green: a server that crash-looped
 * on a DI error, a webapp that could not reach it, runtime config that never
 * arrived and left the socket pointed at nothing.
 */
test.describe('the stack', () => {
  test('the server reports every dependency ready', async ({ request }) => {
    const response = await request.get(`${SERVER_URL}/health/ready`);

    expect(response.status()).toBe(200);
    const report = await response.json();
    expect(report.status).toBe('ready');
    for (const [dependency, status] of Object.entries(report.dependencies)) {
      expect(status, dependency).toBe('up');
    }
  });

  test('the webapp serves the sign-in page', async ({ request }) => {
    const response = await request.get(`${WEBAPP_URL}/auth`);

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/html');
  });

  test('the webapp reports the build it is serving', async ({ request }) => {
    const response = await request.get(`${WEBAPP_URL}/api/version`);

    expect(response.status()).toBe(200);
    const version = await response.json();
    expect(version.buildId).toBeTruthy();
    expect(typeof version.dexieSchemaVersion).toBe('number');
  });

  test('the webapp proxies the API through to the server', async ({ request }) => {
    // This is how the browser learns where the socket lives. When it failed,
    // live updates stopped without an error anywhere.
    const response = await request.get(`${WEBAPP_URL}/api/v1/config`);

    expect(response.status()).toBe(200);
    const config = await response.json();
    expect(config.socketHost).toMatch(/^https?:\/\//);
    expect(typeof config.aiEnabled).toBe('boolean');
  });

  test('the webapp proxies auth routes through to the server', async ({ request }) => {
    const response = await request.get(
      `${WEBAPP_URL}/api/v1/auth/session`,
    );

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.authenticated).toBe(false);
  });
});
