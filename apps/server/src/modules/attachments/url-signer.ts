import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

/**
 * The claims inside a signed URL. A backend that has no bucket to sign against
 * puts these in a token, and the server verifies the token when the client
 * comes back for the file.
 */
export interface SignedUrlClaims {
  filePath: string;
  action: 'read' | 'write';
  /** The time the token stops being valid, in milliseconds since the epoch. */
  expires: number;
  contentType?: string;
  responseDisposition?: string;
  responseType?: string;
}

export class InvalidSignedUrlError extends Error {}

function base64UrlEncode(input: Buffer): string {
  return input.toString('base64url');
}

function sign(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

/**
 * Makes a token that carries the claims and a signature over them. The claims
 * are readable, which is correct: they hold a storage path and no secret, and
 * the signature is what stops a client from changing them.
 */
export function signUrlToken(claims: SignedUrlClaims, secret: string): string {
  const payload = base64UrlEncode(Buffer.from(JSON.stringify(claims), 'utf8'));
  return `${payload}.${base64UrlEncode(sign(payload, secret))}`;
}

/**
 * Reads a token back. Throws InvalidSignedUrlError if the signature is wrong,
 * if the token is malformed, or if the time has passed.
 *
 * The caller must also check that the action matches the request. A read token
 * must not write.
 */
export function verifyUrlToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): SignedUrlClaims {
  const separator = token.lastIndexOf('.');
  if (separator <= 0) {
    throw new InvalidSignedUrlError('Malformed token');
  }

  const payload = token.slice(0, separator);
  const provided = Buffer.from(token.slice(separator + 1), 'base64url');
  const expected = sign(payload, secret);

  // timingSafeEqual throws when the lengths differ, so compare them first.
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    throw new InvalidSignedUrlError('Bad signature');
  }

  let claims: SignedUrlClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidSignedUrlError('Malformed claims');
  }

  if (typeof claims.expires !== 'number' || claims.expires <= now) {
    throw new InvalidSignedUrlError('Token expired');
  }

  return claims;
}

/**
 * Finds the secret that signs attachment URLs.
 *
 * ATTACHMENT_URL_SECRET is the answer when an operator sets it. There is no
 * fixed fallback value, because a known secret lets anyone make a valid URL for
 * any path.
 *
 * When the variable is empty, the server makes a random secret once and keeps
 * it in a file beside the stored files. This is safe and it needs no
 * configuration. The file sits in the volume that local storage already needs,
 * so the secret survives a restart, and every replica that shares that volume
 * reads the same secret. If the server can neither read nor write that file, it
 * has no secret and it must stop.
 */
export function resolveUrlSigningSecret(storageRoot: string): string {
  const configured = process.env.ATTACHMENT_URL_SECRET;
  if (configured) {
    return configured;
  }

  const secretFile = join(storageRoot, '.url-signing-secret');

  if (existsSync(secretFile)) {
    const stored = readFileSync(secretFile, 'utf8').trim();
    if (stored) {
      return stored;
    }
  }

  try {
    mkdirSync(dirname(secretFile), { recursive: true });
    const generated = randomBytes(32).toString('hex');
    // Mode 0600, so only the user that runs the server reads the secret.
    writeFileSync(secretFile, generated, { encoding: 'utf8', mode: 0o600 });
    return generated;
  } catch (error) {
    throw new Error(
      `Unable to establish a secret to sign attachment URLs. Set ` +
        `ATTACHMENT_URL_SECRET, or give the server write access to ` +
        `${storageRoot}. Cause: ${(error as Error).message}`,
    );
  }
}
