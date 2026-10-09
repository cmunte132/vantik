import { resolveSocketUrl, waitForSocketUrl } from './connector';

describe('resolveSocketUrl', () => {
  it('uses the gateway the server announces', async () => {
    const url = await resolveSocketUrl('http://app.test/', async () => ({
      socketHost: 'http://api.test/',
    }));
    expect(url).toBe('http://api.test');
  });

  it('falls back to the URL itself when a server answers without one', async () => {
    const url = await resolveSocketUrl('http://api.test', async () => ({}));
    expect(url).toBe('http://api.test');
  });

  it('gives no answer while the server cannot be reached', async () => {
    const url = await resolveSocketUrl('http://app.test', async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(url).toBeNull();
  });
});

describe('waitForSocketUrl', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('asks again until the server answers, and says so once', async () => {
    const answers = [null, null, 'http://api.test'];
    const resolve = jest.fn(async () => answers.shift() ?? null);
    const log = jest.fn();

    const result = waitForSocketUrl('http://app.test', log, resolve);
    await jest.advanceTimersByTimeAsync(1_000);
    await jest.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toBe('http://api.test');
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
