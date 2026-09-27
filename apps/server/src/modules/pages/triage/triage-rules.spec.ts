/**
 * The rules triage applies in code: what makes two entries different facts,
 * which of two contradicting entries stands, and the policies an entry is
 * held to before any model sees it.
 */
import { KnowledgeTrustEnum } from '@vantikhq/types';

import { preferred } from './precedence';
import { factualDifference } from './relation-guard';
import {
  externalSourceOf,
  type IssueProvenance,
  MAX_ONE_FACT_LENGTH,
  secretIn,
  severalClaimsIn,
} from './triage-policy';

describe('what makes two entries different facts', () => {
  it.each([
    ['30 minutes', '60 minutes'],
    ['version 1.4', 'version 1.5'],
    ['port 5432', 'port 5433'],
    ['at 09:00', 'at 10:00'],
    ['3 retries', 'three retries'],
  ])('[KG-4.2] tells %s from %s by the number', (a, b) => {
    expect(
      factualDifference(`The job runs with ${a}.`, `The job runs with ${b}.`),
    ).toBe('they differ in a number');
  });

  it('[KG-4.2] tells dates apart, and does not read "may" as a month', () => {
    expect(
      factualDifference(
        'Deploys freeze on Friday.',
        'Deploys freeze on Monday.',
      ),
    ).toBe('they differ in a date');
    expect(
      factualDifference(
        'The freeze starts in March.',
        'The freeze starts in April.',
      ),
    ).toBe('they differ in a date');
    expect(
      factualDifference(
        'A deploy may be rolled back by the worker.',
        'A deploy can be rolled back by the worker.',
      ),
    ).toBeNull();
  });

  it('[KG-4.2] tells a negated claim from its opposite, and a double negation from neither', () => {
    expect(
      factualDifference(
        'The worker retries jobs.',
        'The worker does not retry jobs.',
      ),
    ).toBe('one is negated and the other is not');
    expect(
      factualDifference(
        'The worker retries jobs.',
        "The worker doesn't retry jobs.",
      ),
    ).toBe('one is negated and the other is not');
    expect(
      factualDifference(
        'The worker never skips jobs.',
        'The worker does not skip jobs.',
      ),
    ).toBeNull();
  });

  it('[KG-4.2] tells a conditional claim from an unconditional one', () => {
    expect(
      factualDifference(
        'The cache is flushed.',
        'The cache is flushed unless a deploy is running.',
      ),
    ).toBe('they differ in a condition');
    expect(
      factualDifference(
        'Retry when the queue is idle.',
        'Retry until the queue is idle.',
      ),
    ).toBe('they differ in a condition');
  });

  it('[KG-4.2] leaves the pair to the judges when nothing in code sets them apart', () => {
    expect(
      factualDifference(
        'Webhook deliveries are retried by the queue worker.',
        'The queue worker retries webhook deliveries.',
      ),
    ).toBeNull();
  });
});

describe('precedence between contradicting entries', () => {
  const older = new Date('2026-09-01');
  const newer = new Date('2026-09-02');
  const entry = (id: string, trust: KnowledgeTrustEnum, createdAt: Date) => ({
    id,
    trust,
    createdAt,
  });

  it('[KG-4.6] human-verified beats grounded beats ungrounded, whichever is newer and whichever is asked first', () => {
    const verified = entry(
      'verified',
      KnowledgeTrustEnum.HUMAN_VERIFIED,
      older,
    );
    const grounded = entry('grounded', KnowledgeTrustEnum.GROUNDED, newer);
    const ungrounded = entry(
      'ungrounded',
      KnowledgeTrustEnum.UNGROUNDED,
      newer,
    );
    const olderGrounded = entry(
      'older-grounded',
      KnowledgeTrustEnum.GROUNDED,
      older,
    );

    expect(preferred(verified, grounded).id).toBe('verified');
    expect(preferred(grounded, verified).id).toBe('verified');
    expect(preferred(olderGrounded, ungrounded).id).toBe('older-grounded');
    expect(preferred(ungrounded, olderGrounded).id).toBe('older-grounded');
    expect(preferred(ungrounded, verified).id).toBe('verified');
  });

  it('[KG-4.6] within a tier the newer entry wins', () => {
    for (const trust of Object.values(KnowledgeTrustEnum)) {
      const a = entry('a', trust, older);
      const b = entry('b', trust, newer);

      expect(preferred(a, b).id).toBe('b');
      expect(preferred(b, a).id).toBe('b');
    }
  });
});

describe('the policies an entry is held to', () => {
  const issue = (
    overrides: Partial<IssueProvenance> = {},
  ): IssueProvenance => ({
    sourceMetadata: null,
    support: null,
    team: { preferences: {} },
    linkedIssue: [],
    ...overrides,
  });

  // Each built at run time from plainly fake parts, so no scanner mistakes
  // this file for a leak.
  const fakes: Array<[string, string]> = [
    ['private key', ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('')],
    ['GitHub token', ['gh', 'p_', 'x'.repeat(36)].join('')],
    ['GitHub token', ['github', '_pat_', 'x'.repeat(50)].join('')],
    ['AWS access key', ['AK', 'IA', 'X'.repeat(16)].join('')],
    ['Slack token', ['xo', 'xb-', 'x'.repeat(20)].join('')],
    ['model provider key', ['sk', '-ant-', 'x'.repeat(30)].join('')],
    ['Stripe key', ['sk', '_live_', 'x'.repeat(24)].join('')],
    ['Google API key', ['AI', 'za', 'x'.repeat(35)].join('')],
    [
      'JSON web token',
      [
        'ey',
        'J',
        'x'.repeat(10),
        '.ey',
        'J',
        'x'.repeat(10),
        '.',
        'x'.repeat(10),
      ].join(''),
    ],
    [
      'credential in a URL',
      ['postgres://', 'admin:', 'hunter2', '@db.internal/app'].join(''),
    ],
    ['Vantik token', ['tg', '_pat_', 'x'.repeat(20)].join('')],
  ];

  it.each(fakes)('[KG-4.8] finds a %s in content', (name, secret) => {
    expect(secretIn(`Connect with ${secret} before deploying.`)).toBe(name);
  });

  it('[KG-4.8] does not mistake prose about credentials for one', () => {
    for (const prose of [
      'Tokens live in the GITHUB_TOKEN secret, never in the repository.',
      'The sk- prefix marks a provider key; rotate them monthly.',
      'Connect to postgres://db.internal/app with the service account.',
      'Keys are read from AWS Secrets Manager at boot.',
    ]) {
      expect(secretIn(prose)).toBeNull();
    }
  });

  it('[KG-4.8] holds an entry to one fact', () => {
    expect(severalClaimsIn('- one\n- two')).toMatch(/list of 2 items/);
    expect(severalClaimsIn('1. one\n2) two\n3. three')).toMatch(/list of 3/);
    expect(severalClaimsIn('x'.repeat(MAX_ONE_FACT_LENGTH + 1))).toMatch(
      /longer than/,
    );
    expect(severalClaimsIn('Webhooks retry three times.')).toBeNull();
    // One bullet is one claim.
    expect(severalClaimsIn('- Webhooks retry three times.')).toBeNull();
  });

  it('[KG-4.8] reads an issue from an integration, support or a synced thread as outside input', () => {
    expect(
      externalSourceOf(issue({ sourceMetadata: { type: 'github' } })),
    ).toBe('github');
    expect(externalSourceOf(issue({ sourceMetadata: { type: 'email' } }))).toBe(
      'email',
    );
    expect(externalSourceOf(issue({ support: { id: 'ticket' } }))).toBe(
      'support',
    );
    expect(
      externalSourceOf(
        issue({ team: { preferences: { teamType: 'support' } } }),
      ),
    ).toBe('support');
    expect(
      externalSourceOf(
        issue({
          linkedIssue: [{ sourceData: { type: 'discord' }, sync: false }],
        }),
      ),
    ).toBe('discord');
    expect(
      externalSourceOf(
        issue({ linkedIssue: [{ sourceData: {}, sync: true }] }),
      ),
    ).toBe('linked issue');
  });

  it('[KG-4.8] does not read work inside the workspace as outside input', () => {
    expect(externalSourceOf(issue())).toBeNull();
    // A run handing work back says where it came from.
    expect(
      externalSourceOf(issue({ sourceMetadata: { source: 'agent-run' } })),
    ).toBeNull();
    // The pull request is the work itself.
    expect(
      externalSourceOf(
        issue({
          linkedIssue: [
            { sourceData: { type: 'github', githubType: 'PR' }, sync: true },
          ],
        }),
      ),
    ).toBeNull();
  });
});
