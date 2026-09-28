/**
 * Reading a page outside the workspace. The network is a fake: the tests
 * decide what each name resolves to and what each address answers, and
 * they check which address the reader sends each request to.
 */
import {
  findQuote,
  isPublicAddress,
  type OutsideNetwork,
  type OutsideResponse,
  outsideUrl,
  pageText,
  readOutsidePage,
} from './outside-source';

function network(
  names: Record<string, string[]>,
  pages: Record<string, Partial<OutsideResponse>>,
) {
  const sent: Array<{ url: string; address: string }> = [];
  const fake: OutsideNetwork = {
    resolve: async (host) =>
      (names[host] ?? []).map((address) => ({
        address,
        family: address.includes(':') ? 6 : 4,
      })),
    get: async (url, address) => {
      sent.push({ url: url.href, address: address.address });
      const page = pages[url.href];

      return {
        status: 404,
        location: null,
        contentType: 'text/html',
        body: '',
        complete: true,
        ...page,
      };
    },
  };

  return { fake, sent };
}

describe('the addresses the server reads from', () => {
  it('are public ones only', () => {
    for (const address of [
      '93.184.216.34',
      '2606:4700:4700::1111',
      '::ffff:93.184.216.34',
    ]) {
      expect(isPublicAddress(address)).toBe(true);
    }

    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.5',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '2002:a00:1::',
      'not-an-address',
    ]) {
      expect(isPublicAddress(address)).toBe(false);
    }
  });

  it('refuses a URL that is not public https, before any lookup', () => {
    const refused = (value: string) => {
      const url = outsideUrl(value);
      return url instanceof URL ? null : url.refused;
    };

    expect(refused('http://example.com/')).toContain('https');
    expect(refused('https://user:pw@example.com/')).toContain('user name');
    expect(refused('https://example.com:8443/')).toContain('port');
    expect(refused('https://127.0.0.1/')).toContain('not a public address');
    expect(refused('https://[::1]/')).toContain('not a public address');
    expect(refused('https://localhost/')).toContain('not a public address');
    expect(refused('file:///etc/passwd')).toContain('https');
    expect(refused('not a url')).toContain('is not a URL');
    expect(refused('https://docs.example.com/a#part')).toBeNull();
  });
});

describe('reading an outside page', () => {
  it('reads a public page at the address it approved, as text', async () => {
    const { fake, sent } = network(
      { 'docs.example.com': ['93.184.216.34'] },
      {
        'https://docs.example.com/limits': {
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<html><style>p{}</style><script>alert(1)</script><p>Each key: 100&nbsp;requests &amp; more</p></html>',
        },
      },
    );

    expect(
      await readOutsidePage('https://docs.example.com/limits', fake),
    ).toEqual({
      content: 'Each key: 100 requests & more',
      url: 'https://docs.example.com/limits',
    });
    expect(sent).toEqual([
      { url: 'https://docs.example.com/limits', address: '93.184.216.34' },
    ]);
  });

  it('refuses a name with any private address, and sends nothing', async () => {
    const { fake, sent } = network(
      { 'docs.example.com': ['93.184.216.34', '10.0.0.5'] },
      {},
    );

    expect(
      await readOutsidePage('https://docs.example.com/', fake),
    ).toMatchObject({ refused: expect.stringContaining('10.0.0.5') });
    expect(sent).toEqual([]);
  });

  it('checks the target of a redirect as it checks the first', async () => {
    const { fake, sent } = network(
      {
        'docs.example.com': ['93.184.216.34'],
        'internal.example.com': ['169.254.169.254'],
      },
      {
        'https://docs.example.com/': {
          status: 302,
          location: 'https://internal.example.com/latest/meta-data',
        },
      },
    );

    expect(
      await readOutsidePage('https://docs.example.com/', fake),
    ).toMatchObject({ refused: expect.stringContaining('169.254.169.254') });
    expect(sent).toHaveLength(1);
  });

  it('follows a public redirect, and stops after three', async () => {
    const { fake } = network(
      { 'docs.example.com': ['93.184.216.34'] },
      {
        'https://docs.example.com/old': {
          status: 301,
          location: '/new',
        },
        'https://docs.example.com/new': {
          status: 200,
          contentType: 'text/plain',
          body: 'moved here',
        },
        'https://docs.example.com/loop': {
          status: 302,
          location: '/loop',
        },
      },
    );

    expect(await readOutsidePage('https://docs.example.com/old', fake)).toEqual(
      { content: 'moved here', url: 'https://docs.example.com/new' },
    );
    expect(
      await readOutsidePage('https://docs.example.com/loop', fake),
    ).toMatchObject({
      unknown: true,
      reason: expect.stringContaining('too many'),
    });
  });

  it('says a page is gone only on 404 or 410, and unread otherwise', async () => {
    const { fake } = network(
      { 'docs.example.com': ['93.184.216.34'] },
      {
        'https://docs.example.com/gone': { status: 410 },
        'https://docs.example.com/down': { status: 503 },
        'https://docs.example.com/image': {
          status: 200,
          contentType: 'image/png',
          body: 'x',
        },
      },
    );

    expect(
      await readOutsidePage('https://docs.example.com/nothing', fake),
    ).toEqual({ missing: true });
    expect(
      await readOutsidePage('https://docs.example.com/gone', fake),
    ).toEqual({ missing: true });
    expect(
      await readOutsidePage('https://docs.example.com/down', fake),
    ).toMatchObject({ unknown: true });
    expect(
      await readOutsidePage('https://docs.example.com/image', fake),
    ).toMatchObject({
      unknown: true,
      reason: expect.stringContaining('image/png'),
    });
  });

  it('is unread, and never throws, when the network fails', async () => {
    const fake: OutsideNetwork = {
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
      get: jest.fn(),
    };

    expect(await readOutsidePage('https://docs.example.com/', fake)).toEqual({
      unknown: true,
      reason: 'the page could not be read: ENOTFOUND',
    });
  });
});

describe('the text of a page', () => {
  it('leaves plain text as it is, apart from white space', () => {
    expect(pageText('a  <b>\n c', 'text/plain')).toBe('a <b> c');
  });

  it('finds a quote without regard to case or white space, and returns the page’s own words', () => {
    expect(
      findQuote('Each KEY can make\n100 requests.', 'each key can make 100'),
    ).toBe('Each KEY can make 100');
    expect(findQuote('Each key', 'another thing')).toBeNull();
    expect(findQuote('Each key', '   ')).toBeNull();
  });
});
