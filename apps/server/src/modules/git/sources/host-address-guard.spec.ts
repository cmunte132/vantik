import { promises as dns } from 'node:dns';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { getHostRepository, whoAmI } from './git-remote-hosts';
import {
  ALLOW_PRIVATE_HOSTS_ENV,
  assertHostAllowed,
  classifyAddress,
} from './host-address-guard';

const saved = process.env[ALLOW_PRIVATE_HOSTS_ENV];

afterEach(() => {
  jest.restoreAllMocks();

  if (saved === undefined) {
    delete process.env[ALLOW_PRIVATE_HOSTS_ENV];
  } else {
    process.env[ALLOW_PRIVATE_HOSTS_ENV] = saved;
  }
});

function resolveTo(...addresses: string[]) {
  return jest.spyOn(dns, 'lookup').mockResolvedValue(
    addresses.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    })) as never,
  );
}

describe('classifyAddress', () => {
  it.each([
    ['169.254.169.254', 'blocked'],
    ['169.254.0.1', 'blocked'],
    ['0.0.0.0', 'blocked'],
    ['::', 'blocked'],
    ['fe80::1', 'blocked'],
    ['febf::1', 'blocked'],
    ['::ffff:169.254.169.254', 'blocked'],
    ['::ffff:a9fe:a9fe', 'blocked'],
    ['127.0.0.1', 'loopback'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['10.0.0.5', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.10', 'private'],
    ['100.64.0.1', 'private'],
    ['fd00::1', 'private'],
    ['::ffff:192.168.1.10', 'private'],
    ['172.32.0.1', 'public'],
    ['100.128.0.1', 'public'],
    ['8.8.8.8', 'public'],
    ['2606:4700::1111', 'public'],
  ])('sorts %s as %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });
});

describe('assertHostAllowed', () => {
  it('refuses a literal link-local address', async () => {
    await expect(
      assertHostAllowed('http://169.254.169.254/latest'),
    ).rejects.toThrow(/link-local/);
    await expect(assertHostAllowed('http://[fe80::1]:3000')).rejects.toThrow(
      /link-local/,
    );
    await expect(
      assertHostAllowed('http://[::ffff:169.254.169.254]'),
    ).rejects.toThrow(/link-local/);
    await expect(assertHostAllowed('http://0.0.0.0:3000')).rejects.toThrow();
  });

  it('refuses a host name that resolves to a link-local address', async () => {
    resolveTo('93.184.216.34', '169.254.169.254');

    await expect(assertHostAllowed('https://git.example.com')).rejects.toThrow(
      /git\.example\.com resolves to 169\.254\.169\.254/,
    );
  });

  it('accepts a literal private address by default, with no lookup', async () => {
    const lookup = resolveTo('169.254.169.254');

    await expect(
      assertHostAllowed('http://192.168.1.10:3000'),
    ).resolves.toBeUndefined();
    await expect(assertHostAllowed('http://10.0.0.5')).resolves.toBeUndefined();
    await expect(
      assertHostAllowed('http://[fd00::1]:3000'),
    ).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('accepts a host name that resolves to a private address by default', async () => {
    resolveTo('192.168.1.10');

    await expect(
      assertHostAllowed('http://forgejo.lan:3000'),
    ).resolves.toBeUndefined();
  });

  it('refuses private, loopback and CGNAT addresses if the setting is false', async () => {
    process.env[ALLOW_PRIVATE_HOSTS_ENV] = 'false';

    for (const url of [
      'http://192.168.1.10',
      'http://10.0.0.5',
      'http://172.16.0.1',
      'http://100.64.0.1',
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
      'http://[fd00::1]:3000',
    ]) {
      await expect(assertHostAllowed(url)).rejects.toThrow(GIT_REMOTE_SETTING);
    }

    resolveTo('10.1.2.3');
    await expect(assertHostAllowed('http://forgejo.lan')).rejects.toThrow(
      GIT_REMOTE_SETTING,
    );
  });

  it('accepts a public address if the setting is false', async () => {
    process.env[ALLOW_PRIVATE_HOSTS_ENV] = 'false';
    resolveTo('93.184.216.34');

    await expect(
      assertHostAllowed('https://git.example.com'),
    ).resolves.toBeUndefined();
    await expect(assertHostAllowed('http://8.8.8.8')).resolves.toBeUndefined();
  });
});

const GIT_REMOTE_SETTING = new RegExp(ALLOW_PRIVATE_HOSTS_ENV);

describe('host API calls', () => {
  let server: Server;
  let baseUrl: string;
  let hits: string[];

  beforeEach(async () => {
    hits = [];
    server = createServer((req, res) => {
      hits.push(req.url ?? '');

      if (req.url?.startsWith('/api/v1/user')) {
        res.writeHead(302, { Location: 'http://127.0.0.1:1/elsewhere' });
        res.end();

        return;
      }

      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 1, full_name: 'a/b', private: false }));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((done) => server.close(done));
  });

  it('reaches a host by a literal private IP with the default setting', async () => {
    const repo = await getHostRepository(
      { kind: 'forgejo', baseUrl, username: '' },
      null,
      'a/b',
    );

    expect(repo.fullName).toBe('a/b');
    expect(hits).toEqual(['/api/v1/repos/a/b']);
  });

  it('does not follow a redirect', async () => {
    await expect(
      whoAmI({ kind: 'forgejo', baseUrl, username: '' }, 'token'),
    ).rejects.toMatchObject({ response: { status: 302 } });
    expect(hits).toEqual(['/api/v1/user']);
  });

  it('sends no request to a link-local host', async () => {
    await expect(
      getHostRepository(
        { kind: 'forgejo', baseUrl: 'http://169.254.169.254', username: '' },
        null,
        'a/b',
      ),
    ).rejects.toThrow(/link-local/);
  });

  it('refuses a loopback host if the setting is false', async () => {
    process.env[ALLOW_PRIVATE_HOSTS_ENV] = 'false';

    await expect(
      getHostRepository(
        { kind: 'forgejo', baseUrl, username: '' },
        null,
        'a/b',
      ),
    ).rejects.toThrow(GIT_REMOTE_SETTING);
    expect(hits).toEqual([]);
  });
});
