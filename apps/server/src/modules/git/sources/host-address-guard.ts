import {
  lookup as dnsLookup,
  type LookupAddress,
  promises as dns,
} from 'node:dns';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { isIP } from 'node:net';

/**
 * The name of the setting that allows addresses in a private range. The
 * default is true, because many people run a git host on a LAN and reach it
 * by an address such as `192.168.1.10`. Set it to `false` or `0` on a server
 * that must reach public hosts only.
 */
export const ALLOW_PRIVATE_HOSTS_ENV = 'GIT_REMOTE_ALLOW_PRIVATE_HOSTS';

/** This function reads the setting at the time of the call. */
export function allowsPrivateHosts(): boolean {
  const value = process.env[ALLOW_PRIVATE_HOSTS_ENV]?.trim().toLowerCase();

  return value !== 'false' && value !== '0';
}

/** The kind of an address, as the guard sorts it. */
export type AddressClass = 'public' | 'private' | 'loopback' | 'blocked';

/**
 * This function sorts an IP address.
 *
 * `blocked` is an address that the guard always refuses: link-local (the
 * cloud metadata range is here) and unspecified. `loopback` and `private`
 * are refused only if the setting turns private hosts off.
 */
export function classifyAddress(address: string): AddressClass {
  const bytes = parseAddress(address);

  if (!bytes) {
    return 'blocked';
  }

  if (bytes.length === 16) {
    const mapped =
      bytes.slice(0, 10).every((b) => b === 0) &&
      bytes[10] === 0xff &&
      bytes[11] === 0xff;

    if (mapped) {
      return classifyV4(bytes.slice(12));
    }
    if (bytes.every((b) => b === 0)) {
      return 'blocked';
    }
    if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) {
      return 'loopback';
    }
    // fe80::/10
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) {
      return 'blocked';
    }
    // fc00::/7
    if ((bytes[0] & 0xfe) === 0xfc) {
      return 'private';
    }

    return 'public';
  }

  return classifyV4(bytes);
}

function classifyV4(b: number[]): AddressClass {
  if (b[0] === 0 && b.every((x) => x === 0)) {
    return 'blocked';
  }
  if (b[0] === 169 && b[1] === 254) {
    return 'blocked';
  }
  if (b[0] === 127) {
    return 'loopback';
  }
  if (
    b[0] === 10 ||
    (b[0] === 172 && b[1] >= 16 && b[1] <= 31) ||
    (b[0] === 192 && b[1] === 168) ||
    (b[0] === 100 && b[1] >= 64 && b[1] <= 127)
  ) {
    return 'private';
  }

  return 'public';
}

/** This function returns the bytes of an IPv4 (4) or IPv6 (16) address. */
function parseAddress(address: string): number[] | null {
  const kind = isIP(address);

  if (kind === 4) {
    return address.split('.').map(Number);
  }
  if (kind !== 6) {
    return null;
  }

  let text = address.split('%')[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);

  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    const tail = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;

    text = text.slice(0, -dotted[1].length) + tail;
  }

  const [head, rest, extra] = text.split('::');

  if (extra !== undefined) {
    return null;
  }

  const left = head ? head.split(':') : [];
  const right = rest ? rest.split(':') : [];
  const fill = rest === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array(Math.max(fill, 0)).fill('0'), ...right];

  if (groups.length !== 8) {
    return null;
  }

  return groups.flatMap((group) => {
    const value = parseInt(group, 16);

    return [(value >> 8) & 0xff, value & 0xff];
  });
}

/** This function throws if the setting does not allow the address. */
export function assertAddressAllowed(address: string, name = address): void {
  const kind = classifyAddress(address);

  if (kind === 'blocked') {
    throw new Error(
      `${name} resolves to ${address}, a link-local or unspecified address. The server never connects to these.`,
    );
  }

  if (kind !== 'public' && !allowsPrivateHosts()) {
    throw new Error(
      `${name} resolves to ${address}, a private address, and ${ALLOW_PRIVATE_HOSTS_ENV} is false.`,
    );
  }
}

/**
 * This function checks the host of a base URL before the server sends a
 * request to it. A literal IP address needs no lookup. A name is resolved,
 * and every address that it resolves to must pass.
 */
export async function assertHostAllowed(baseUrl: string): Promise<void> {
  const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');

  if (isIP(hostname)) {
    assertAddressAllowed(hostname);

    return;
  }

  let addresses: LookupAddress[];

  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (error) {
    throw new Error(
      `The server cannot resolve ${hostname} (${(error as NodeJS.ErrnoException).code ?? 'lookup failed'})`,
    );
  }

  for (const { address } of addresses) {
    assertAddressAllowed(address, hostname);
  }
}

/**
 * This function does the lookup for a socket and checks the result. It
 * closes the gap between the check before the request and the connect: a
 * host name that changes its address in between still fails here.
 */
function checkedLookup(
  hostname: string,
  options: object,
  callback: (...args: unknown[]) => void,
): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error);

      return;
    }

    try {
      for (const { address } of addresses as LookupAddress[]) {
        assertAddressAllowed(address, hostname);
      }
    } catch (refused) {
      callback(refused);

      return;
    }

    if ((options as { all?: boolean }).all) {
      callback(null, addresses);
    } else {
      const [first] = addresses as LookupAddress[];

      callback(null, first.address, first.family);
    }
  });
}

/** The agents that check each address at connect time. */
export const guardedAgents = {
  httpAgent: new HttpAgent({ lookup: checkedLookup as never }),
  httpsAgent: new HttpsAgent({ lookup: checkedLookup as never }),
};
