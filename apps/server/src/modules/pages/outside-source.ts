import type { IncomingMessage } from 'node:http';

import { lookup as dnsLookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * Reads a page outside the workspace, for a fact about an outside service.
 *
 * The server reads the page itself, as it reads cited code: the writer's copy
 * of the page is never the evidence. The server reads only public https
 * pages. Each address that a name resolves to must be a public address, and
 * the request goes to the address that the check approved, so a name cannot
 * resolve to a public address for the check and to a private one for the
 * request. The server follows a redirect only after it checks the new target
 * in the same way. A page that is too large, too slow, or not text is unread.
 */

/** The result of one read of an outside page. */
export type OutsideRead =
  | { content: string; url: string }
  | { missing: true }
  | { unknown: true; reason: string }
  /** The address is one the server does not read, for example a private one. */
  | { refused: string };

export const MAX_OUTSIDE_URL = 2000;
export const MAX_OUTSIDE_BYTES = 2 * 1024 * 1024;
export const OUTSIDE_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

/** The shortest quote from a page that a citation of it can give. */
export const MIN_OUTSIDE_QUOTE = 20;
export const MAX_OUTSIDE_QUOTE = 1000;

/**
 * How long an observation of an outside page stays current. After this
 * time, the gardener reads the page again.
 */
export const OBSERVED_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;

const TEXT_TYPES = [
  'text/html',
  'text/plain',
  'text/markdown',
  'application/json',
  'application/xhtml+xml',
];

const BLOCKED = new BlockList();

for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv4');
}

// An IPv6 address must be global unicast (2000::/3). These ranges in it
// are not public, or they can carry an IPv4 address that is not.
for (const [net, prefix] of [
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv6');
}

const GLOBAL_UNICAST = new BlockList();
GLOBAL_UNICAST.addSubnet('2000::', 3, 'ipv6');

/** Whether an address is one the server can read a page from. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);

  if (family === 4) {
    return !BLOCKED.check(address, 'ipv4');
  }

  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];

    if (mapped) {
      return isPublicAddress(mapped);
    }

    return (
      GLOBAL_UNICAST.check(address, 'ipv6') && !BLOCKED.check(address, 'ipv6')
    );
  }

  return false;
}

/**
 * The URL of an outside page, or the reason the server does not read it.
 * Only https on the default port, with no user name or password in it.
 */
export function outsideUrl(value: string): URL | { refused: string } {
  let url: URL;

  try {
    url = new URL(value.trim());
  } catch {
    return { refused: `"${value}" is not a URL` };
  }

  if (value.length > MAX_OUTSIDE_URL) {
    return { refused: 'the URL is too long' };
  }

  if (url.protocol !== 'https:') {
    return { refused: 'only an https URL can be cited' };
  }

  if (url.username || url.password) {
    return { refused: 'a URL with a user name or a password cannot be cited' };
  }

  if (url.port && url.port !== '443') {
    return { refused: 'only a URL on the default https port can be cited' };
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (isIP(host) && !isPublicAddress(host)) {
    return { refused: `${host} is not a public address` };
  }

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { refused: `${host} is not a public address` };
  }

  url.hash = '';

  return url;
}

/**
 * The text of a page, as a reader sees it. The function removes scripts,
 * styles and tags, decodes the common entities, and collapses the white
 * space.
 */
export function pageText(body: string, contentType: string): string {
  const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

  if (!/html/i.test(contentType)) {
    return flat(body);
  }

  return flat(
    decodeEntities(
      body
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(
          /<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi,
          ' ',
        )
        .replace(/<[^>]+>/g, ' '),
    ),
  );
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    const lower = String(name).toLowerCase();

    if (lower.startsWith('#x')) {
      return safeCodePoint(parseInt(lower.slice(2), 16)) ?? whole;
    }

    if (lower.startsWith('#')) {
      return safeCodePoint(parseInt(lower.slice(1), 10)) ?? whole;
    }

    return ENTITIES[lower] ?? whole;
  });
}

function safeCodePoint(code: number): string | null {
  try {
    return Number.isFinite(code) ? String.fromCodePoint(code) : null;
  } catch {
    return null;
  }
}

/**
 * Where a quote is in a page's text, compared without case and with the white
 * space collapsed. The result is the page's own text at that place, so that
 * the stored snippet is what the server read and not what the writer sent.
 */
export function findQuote(text: string, quote: string): string | null {
  const flat = text.replace(/\s+/g, ' ');
  const expected = quote.replace(/\s+/g, ' ').trim();

  if (!expected) {
    return null;
  }

  const at = flat.toLowerCase().indexOf(expected.toLowerCase());

  return at === -1 ? null : flat.slice(at, at + expected.length);
}

/** One response, as the reader needs it. */
export interface OutsideResponse {
  status: number;
  location: string | null;
  contentType: string;
  body: string;
  /** False when the page was larger than the reader reads. */
  complete: boolean;
}

/** The two network steps, apart so that a test can replace them. */
export interface OutsideNetwork {
  resolve(host: string): Promise<Array<{ address: string; family: number }>>;
  get(
    url: URL,
    address: { address: string; family: number },
    signal: AbortSignal,
  ): Promise<OutsideResponse>;
}

export const NETWORK: OutsideNetwork = {
  resolve: (host) => dnsLookup(host, { all: true, verbatim: true }),
  get: pinnedGet,
};

/** Reads an outside page. This function never throws. */
export async function readOutsidePage(
  value: string,
  network: OutsideNetwork = NETWORK,
): Promise<OutsideRead> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OUTSIDE_TIMEOUT_MS);

  try {
    let target = outsideUrl(value);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!(target instanceof URL)) {
        return target;
      }

      const address = await approvedAddress(target, network);

      if ('refused' in address) {
        return address;
      }

      const response = await network.get(target, address, controller.signal);

      if (response.status >= 300 && response.status < 400) {
        if (!response.location) {
          return { unknown: true, reason: 'a redirect named no page' };
        }

        target = outsideUrl(new URL(response.location, target).href);
        continue;
      }

      if (response.status === 404 || response.status === 410) {
        return { missing: true };
      }

      if (response.status < 200 || response.status >= 300) {
        return {
          unknown: true,
          reason: `the page answered with status ${response.status}`,
        };
      }

      const type = response.contentType.split(';')[0].trim().toLowerCase();

      if (!TEXT_TYPES.includes(type) && !type.startsWith('text/')) {
        return {
          unknown: true,
          reason: `the page is ${type || 'of no stated type'}, not text`,
        };
      }

      return {
        content: pageText(response.body, type),
        url: target.href,
      };
    }

    return { unknown: true, reason: 'the page redirected too many times' };
  } catch (error) {
    return {
      unknown: true,
      reason: controller.signal.aborted
        ? `the page did not answer within ${OUTSIDE_TIMEOUT_MS / 1000} seconds`
        : `the page could not be read: ${(error as Error)?.message ?? error}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The address to send the request to. Every address of the name must be
 * public: a name with one private address can be made to use it.
 */
async function approvedAddress(
  url: URL,
  network: OutsideNetwork,
): Promise<{ address: string; family: number } | { refused: string }> {
  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (isIP(host)) {
    return isPublicAddress(host)
      ? { address: host, family: isIP(host) }
      : { refused: `${host} is not a public address` };
  }

  const addresses = await network.resolve(host);

  if (addresses.length === 0) {
    return { refused: `${host} has no address` };
  }

  const blocked = addresses.find(({ address }) => !isPublicAddress(address));

  if (blocked) {
    return {
      refused: `${host} resolves to ${blocked.address}, which is not a public address`,
    };
  }

  return addresses[0];
}

/** A GET to one approved address, with the name kept for TLS. */
function pinnedGet(
  url: URL,
  address: { address: string; family: number },
  signal: AbortSignal,
): Promise<OutsideResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        signal,
        headers: {
          accept: 'text/html, text/plain, text/markdown, application/json',
          'accept-encoding': 'identity',
          'user-agent': 'Vantik knowledge check',
        },
        lookup: (_host, options, callback) => {
          if ((options as { all?: boolean })?.all) {
            (
              callback as unknown as (
                error: null,
                addresses: Array<{ address: string; family: number }>,
              ) => void
            )(null, [address]);
          } else {
            callback(null, address.address, address.family);
          }
        },
      },
      (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location ?? null;
        const contentType = String(response.headers['content-type'] ?? '');

        if (status >= 300 && status < 400) {
          response.resume();
          resolve({ status, location, contentType, body: '', complete: true });
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        let complete = true;

        response.on('data', (chunk: Buffer) => {
          if (size >= MAX_OUTSIDE_BYTES) {
            return;
          }

          size += chunk.length;
          chunks.push(chunk);

          if (size >= MAX_OUTSIDE_BYTES) {
            complete = false;
            response.destroy();
            resolve(done());
          }
        });
        response.on('end', () => resolve(done()));
        response.on('error', reject);

        function done(): OutsideResponse {
          return {
            status,
            location,
            contentType,
            body: Buffer.concat(chunks)
              .subarray(0, MAX_OUTSIDE_BYTES)
              .toString('utf8'),
            complete,
          };
        }
      },
    );

    req.on('error', reject);
    req.end();
  });
}
