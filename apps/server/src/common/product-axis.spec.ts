import { BadRequestException } from '@nestjs/common';

import { assertSingleOwner, toKey, uniqueKey } from './product-axis';

describe('toKey', () => {
  it('lowercases a name and joins its words with dashes', () => {
    expect(toKey('Cloud Platform')).toBe('cloud-platform');
  });

  it('collapses a run of other characters into one dash', () => {
    expect(toKey('Cloud   ///   Platform')).toBe('cloud-platform');
  });

  it('leaves no dash at either end', () => {
    expect(toKey('  ...Docs...  ')).toBe('docs');
    expect(toKey('.github')).toBe('github');
    expect(toKey('---api---')).toBe('api');
  });

  it('falls back when a name leaves nothing behind', () => {
    expect(toKey('!!!', 'product')).toBe('product');
    expect(toKey('   ')).toBe('item');
  });

  it('keeps digits', () => {
    expect(toKey('S3 Storage v2')).toBe('s3-storage-v2');
  });

  /**
   * The trimming used to be a second regular expression anchored at one end,
   * which is the shape a scanner reads as a slow one. This is here so that the
   * single-pass form is not quietly replaced by the two-pass one again.
   *
   * There is no clock in this test on purpose: a wall-clock assertion inside a
   * parallel run fails for reasons that have nothing to do with the code. The
   * input is the guard instead. A backtracking trim is quadratic, so two hundred
   * thousand separators would take it far past the timeout jest already applies,
   * while the single pass returns immediately.
   */
  it('stays linear on a long run of separators', () => {
    expect(toKey(`a${'-'.repeat(200_000)}a`)).toBe('a-a');
    expect(toKey(`a${'!'.repeat(200_000)}a`)).toBe('a-a');
  });
});

describe('uniqueKey', () => {
  it('returns the candidate when nothing holds it', async () => {
    const taken = jest.fn(async () => false);

    await expect(uniqueKey('docs', taken)).resolves.toBe('docs');
  });

  it('suffixes until it finds a free key', async () => {
    const used = new Set(['docs', 'docs-2', 'docs-3']);

    await expect(uniqueKey('docs', async (key) => used.has(key))).resolves.toBe(
      'docs-4',
    );
  });

  /**
   * The unique index covers deleted rows, so a `taken` that hid them reported a
   * key free that the database would then refuse. The suffixing is what has to
   * happen instead, and it only happens if the caller counts those rows — which
   * is what the services now do.
   */
  it('suffixes around a key that only a deleted row holds', async () => {
    const rows = [
      { key: 'docs', deleted: new Date() },
      { key: 'docs-2', deleted: null },
    ];
    const taken = async (key: string) => rows.some((row) => row.key === key);

    await expect(uniqueKey('docs', taken)).resolves.toBe('docs-3');
  });

  it('gives up on suffixes rather than looping for ever', async () => {
    const result = await uniqueKey('docs', async () => true);

    expect(result).toMatch(/^docs-\d+$/);
    expect(result).not.toBe('docs-99');
  });
});

describe('assertSingleOwner', () => {
  it('accepts a team owner', () => {
    expect(() => assertSingleOwner('team-1', null)).not.toThrow();
  });

  it('accepts a product owner', () => {
    expect(() => assertSingleOwner(null, 'product-1')).not.toThrow();
  });

  it('refuses two owners', () => {
    expect(() => assertSingleOwner('team-1', 'product-1')).toThrow(
      BadRequestException,
    );
  });

  it('refuses no owner', () => {
    expect(() => assertSingleOwner(null, undefined)).toThrow(
      BadRequestException,
    );
  });
});
