import { changeRequestNumber } from './git-source';

describe('changeRequestNumber', () => {
  const repo = { fullName: 'cmunte/vantik-llm' };

  it('reads the number from GitHub, Forgejo and GitLab addresses', () => {
    expect(
      changeRequestNumber(repo, 'https://github.com/cmunte/vantik-llm/pull/7'),
    ).toBe(7);
    expect(
      changeRequestNumber(
        repo,
        'https://forgejo.spul.app/cmunte/vantik-llm/pulls/12',
      ),
    ).toBe(12);
    expect(
      changeRequestNumber(
        repo,
        'https://gitlab.example/cmunte/vantik-llm/-/merge_requests/3',
      ),
    ).toBe(3);
  });

  it('allows for a host served under a path', () => {
    expect(
      changeRequestNumber(
        repo,
        'https://example.com/git/cmunte/vantik-llm/pulls/4',
        '/git',
      ),
    ).toBe(4);
  });

  it('refuses an address in another repository', () => {
    expect(
      changeRequestNumber(repo, 'https://github.com/someone/else/pull/7'),
    ).toBeNull();
    expect(
      changeRequestNumber(
        repo,
        'https://github.com/evil/cmunte/vantik-llm-fork/pull/7',
      ),
    ).toBeNull();
    expect(
      changeRequestNumber(
        repo,
        'https://github.com/evil/cmunte/vantik-llm/pull/7',
      ),
    ).toBeNull();
    expect(changeRequestNumber(repo, 'not a url')).toBeNull();
  });
});
