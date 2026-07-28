import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  InvalidSignedUrlError,
  resolveUrlSigningSecret,
  signUrlToken,
  verifyUrlToken,
} from './url-signer';

const SECRET = 'a-secret-for-tests';

function claims(overrides = {}) {
  return {
    filePath: 'workspace-1/attachment-1.png',
    action: 'read' as const,
    expires: Date.now() + 60_000,
    ...overrides,
  };
}

describe('signed URL tokens', () => {
  it('reads back what it signed', () => {
    const original = claims({
      contentType: 'image/png',
      responseDisposition: 'inline',
    });

    expect(verifyUrlToken(signUrlToken(original, SECRET), SECRET)).toEqual(
      original,
    );
  });

  it('refuses a token signed with another secret', () => {
    const token = signUrlToken(claims(), 'a-different-secret');

    expect(() => verifyUrlToken(token, SECRET)).toThrow(InvalidSignedUrlError);
  });

  // The claims travel in the open, so the signature is the only thing that
  // stops a caller reaching a file that the server never offered.
  it('refuses a token whose claims were changed', () => {
    const token = signUrlToken(claims(), SECRET);
    const [, signature] = token.split('.');

    const forged = Buffer.from(
      JSON.stringify(claims({ filePath: 'another-workspace/secret.pdf' })),
      'utf8',
    ).toString('base64url');

    expect(() => verifyUrlToken(`${forged}.${signature}`, SECRET)).toThrow(
      InvalidSignedUrlError,
    );
  });

  it('refuses a token whose signature was changed', () => {
    const [payload] = signUrlToken(claims(), SECRET).split('.');
    const wrong = Buffer.from('not-the-signature').toString('base64url');

    expect(() => verifyUrlToken(`${payload}.${wrong}`, SECRET)).toThrow(
      InvalidSignedUrlError,
    );
  });

  it('refuses a token after its time passes', () => {
    const token = signUrlToken(claims({ expires: Date.now() + 1000 }), SECRET);

    expect(() => verifyUrlToken(token, SECRET, Date.now() + 2000)).toThrow(
      /expired/i,
    );
  });

  it('refuses a token with no signature at all', () => {
    expect(() => verifyUrlToken('no-separator-here', SECRET)).toThrow(
      InvalidSignedUrlError,
    );
  });

  it('keeps the action, so a read token cannot be read as a write token', () => {
    const token = signUrlToken(claims({ action: 'write' }), SECRET);

    expect(verifyUrlToken(token, SECRET).action).toBe('write');
  });
});

describe('the secret that signs URLs', () => {
  const original = process.env;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vantik-secret-'));
    process.env = { ...original };
    delete process.env.ATTACHMENT_URL_SECRET;
  });

  afterEach(() => {
    process.env = original;
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  });

  it('takes ATTACHMENT_URL_SECRET when the operator sets it', () => {
    process.env.ATTACHMENT_URL_SECRET = 'chosen-by-the-operator';

    expect(resolveUrlSigningSecret(root)).toBe('chosen-by-the-operator');
  });

  it('makes one when the variable is empty, and keeps it', () => {
    const first = resolveUrlSigningSecret(root);

    expect(first).toHaveLength(64);
    // A second server, or the same one after a restart, reads the same value.
    expect(resolveUrlSigningSecret(root)).toBe(first);
  });

  it('never uses a fixed value, so two installations differ', () => {
    const other = mkdtempSync(join(tmpdir(), 'vantik-secret-'));

    try {
      expect(resolveUrlSigningSecret(root)).not.toBe(
        resolveUrlSigningSecret(other),
      );
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('keeps the secret file to itself', () => {
    resolveUrlSigningSecret(root);
    const mode = statSync(join(root, '.url-signing-secret')).mode;

    // Owner reads and writes. Nobody else does.
    expect(mode & 0o077).toBe(0);
  });

  it('writes the secret it returns', () => {
    const secret = resolveUrlSigningSecret(root);

    expect(readFileSync(join(root, '.url-signing-secret'), 'utf8').trim()).toBe(
      secret,
    );
  });

  it('stops when it can neither read a secret nor write one', () => {
    chmodSync(root, 0o500);

    expect(() => resolveUrlSigningSecret(root)).toThrow(
      /ATTACHMENT_URL_SECRET/,
    );
  });
});
