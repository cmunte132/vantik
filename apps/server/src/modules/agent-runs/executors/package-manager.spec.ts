import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROVIDE_PACKAGE_MANAGER,
  READ_PACKAGE_MANAGER,
} from './package-manager';

/** Runs the guest's parser, with real Node, against one package.json. */
function read(packageJson: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), 'package-manager-'));

  try {
    if (packageJson !== undefined) {
      writeFileSync(join(dir, 'package.json'), packageJson);
    }
    return execFileSync(process.execPath, ['-e', READ_PACKAGE_MANAGER], {
      cwd: dir,
      encoding: 'utf8',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pinned = (value: unknown) => JSON.stringify({ packageManager: value });

describe('the package manager a repository pins', () => {
  it.each([
    ['pnpm@10.34.5', 'pnpm@10.34.5'],
    ['pnpm@9.0.0-rc.1', 'pnpm@9.0.0-rc.1'],
    ['yarn@1.22.22', 'yarn@1.22.22'],
  ])('is read from %s', (value, expected) => {
    expect(read(pinned(value))).toBe(expected);
  });

  it('is read without the hash corepack allows after it', () => {
    expect(read(pinned('pnpm@10.34.5+sha512.0123abcdef'))).toBe('pnpm@10.34.5');
  });

  it.each([
    ['a version that carries shell text', 'pnpm@1.0.0; rm -rf /'],
    ['a range rather than a version', 'pnpm@^10'],
    ['a tag', 'pnpm@latest'],
    ['npm, which the guest already has', 'npm@10.0.0'],
    ['another package', 'left-pad@1.0.0'],
    ['a value that is not a string', 42],
  ])('is nothing for %s', (_, value) => {
    expect(read(pinned(value))).toBe('');
  });

  it.each([
    ['no field', '{}'],
    ['a package.json that is not JSON', '{ nope'],
    ['no package.json', undefined],
  ])('is nothing for %s', (_, packageJson) => {
    expect(read(packageJson)).toBe('');
  });

  it('reaches npm as one quoted argument, never as shell text', () => {
    expect(PROVIDE_PACKAGE_MANAGER).toContain('--no-fund "$pm"');
    expect(PROVIDE_PACKAGE_MANAGER).not.toMatch(/eval|\$\(\s*echo/);
  });
});
