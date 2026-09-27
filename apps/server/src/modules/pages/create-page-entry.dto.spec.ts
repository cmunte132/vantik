/**
 * The shape of a write's citations, checked before the service sees them. The
 * service checks what they say; this checks that they can be read at all.
 */
import { CreatePageEntryDto, MAX_ENTRY_CITATIONS } from '@vantikhq/types';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

async function errorsFor(body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(CreatePageEntryDto, body));
  return errors.map((error) => error.property);
}

describe('citations on CreatePageEntryDto', () => {
  it('[KG-2.1] accepts code and the four kinds of decision record', async () => {
    await expect(
      errorsFor({
        content: 'A fact.',
        citations: [
          {
            path: 'src/a.ts',
            lines: '40-52',
            sha: 'abcdef1',
            repo: 'acme/api',
          },
          { issue: 'ENG-42' },
          { pullRequest: 'https://github.com/acme/api/pull/5' },
          { comment: '6f1c1f0e-8b2a-4c3d-9e4f-1a2b3c4d5e6f' },
          { run: '7a2d2e1f-9c3b-4d4e-8f5a-2b3c4d5e6f70' },
        ],
      }),
    ).resolves.toEqual([]);
  });

  it('[KG-2.1] refuses citations that are not a list of citations, or too many of them', async () => {
    await expect(
      errorsFor({ content: 'A fact.', citations: 'src/a.ts:4' }),
    ).resolves.toEqual(['citations']);
    await expect(
      errorsFor({ content: 'A fact.', citations: [{ path: 42 }] }),
    ).resolves.toEqual(['citations']);
    await expect(
      errorsFor({ content: 'A fact.', citations: [{ comment: 'not-an-id' }] }),
    ).resolves.toEqual(['citations']);
    await expect(
      errorsFor({
        content: 'A fact.',
        citations: Array.from({ length: MAX_ENTRY_CITATIONS + 1 }, () => ({
          issue: 'ENG-1',
        })),
      }),
    ).resolves.toEqual(['citations']);
  });
});
