/**
 * The parts of the runner that are worth testing without a git repository or a
 * model: branch naming, diffstat parsing, and the failure taxonomy.
 *
 * The end-to-end behaviour — claim, work, deliver, report — is verified against
 * a live stack with a stub harness, because a mocked git is a test of the mock.
 */
import { branchName } from './git';
import { FAILURE_ADVICE, RunnerError, type AgentRunFailure } from './failures';

describe('branchName', () => {
  it('reads as a branch a person would have written', () => {
    expect(branchName('agent', 'ENG-42', 'Search returns deleted issues')).toBe(
      'agent/eng-42-search-returns-deleted-issues',
    );
  });

  it('strips everything git refs reject from a title', () => {
    // An issue title is user input and can contain anything at all. Refs
    // cannot contain spaces, `~`, `^`, `:`, `?`, `*`, `[`, `\` or `..`.
    const branch = branchName(
      'agent',
      'ENG-1',
      'Fix: the ~weird~ thing [again]?? *urgent*',
    );

    expect(branch).toMatch(/^agent\/eng-1-[a-z0-9-]+$/);
    expect(branch).not.toMatch(/[~^:?*[\]\\ ]/);
  });

  it('never ends on a separator', () => {
    // Truncation lands mid-word often enough that this is a real case, and
    // `git` rejects a ref ending in a dot or slash.
    const branch = branchName('agent', 'ENG-1', 'a'.repeat(40) + ' trailing');
    expect(branch.endsWith('-')).toBe(false);
  });

  it('falls back to the key alone when a title slugs to nothing', () => {
    expect(branchName('agent', 'ENG-7', '???')).toBe('agent/eng-7');
  });

  it('tolerates a prefix given with a trailing slash', () => {
    expect(branchName('agent/', 'ENG-7', 'Thing')).toBe('agent/eng-7-thing');
  });
});

describe('failure taxonomy', () => {
  it('carries the category on the error rather than leaving it to be guessed', () => {
    const error = new RunnerError('PUSH_REJECTED', 'protected branch');

    expect(error.failure).toBe('PUSH_REJECTED');
    expect(error).toBeInstanceOf(Error);
  });

  it('has actionable advice for every category', () => {
    // The point of a typed category is that it tells the user where to go.
    // A category with no advice is a category that should not exist.
    const categories: AgentRunFailure[] = [
      'ENVIRONMENT_SETUP_FAILED',
      'HARNESS_CRASHED',
      'BUDGET_EXHAUSTED',
      'NO_DIFF_PRODUCED',
      'VERIFICATION_FAILED',
      'PUSH_REJECTED',
      'PR_CREATION_FAILED',
      'EGRESS_DENIED',
      'LEASE_LOST',
      'NOT_TEST_SPECIFIABLE',
      'REWARD_HACK_SUSPECTED',
    ];

    for (const category of categories) {
      expect(FAILURE_ADVICE[category]?.length ?? 0).toBeGreaterThan(30);
    }
  });
});
