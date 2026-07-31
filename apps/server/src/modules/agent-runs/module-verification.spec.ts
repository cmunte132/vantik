import { chooseVerification } from './module-verification';

/**
 * What an issue's modules agree the run may do to check itself.
 *
 * These commands are executed, so the shape is checked rather than trusted and
 * disagreement is dropped rather than resolved — running the wrong test
 * command is worse than running none, and the same reasoning already governs
 * which repository a run opens.
 */
describe('chooseVerification', () => {
  it('takes the commands when one module defines them', () => {
    const { verification, conflicts } = chooseVerification([
      {
        verification: { testCommand: 'pnpm test', buildCommand: 'pnpm build' },
      },
    ]);

    expect(verification).toEqual({
      testCommand: 'pnpm test',
      buildCommand: 'pnpm build',
    });
    expect(conflicts).toEqual([]);
  });

  it('keeps a command two modules agree on', () => {
    const { verification, conflicts } = chooseVerification([
      { verification: { testCommand: 'pnpm turbo test' } },
      { verification: { testCommand: 'pnpm turbo test' } },
    ]);

    expect(verification.testCommand).toBe('pnpm turbo test');
    expect(conflicts).toEqual([]);
  });

  it('drops a command two modules disagree on, and names it', () => {
    const { verification, conflicts } = chooseVerification([
      { verification: { buildCommand: 'pnpm --filter webapp build' } },
      { verification: { buildCommand: 'go build ./...' } },
    ]);

    expect(verification.buildCommand).toBeUndefined();
    expect(conflicts).toEqual(['buildCommand']);
  });

  it('resolves each command on its own', () => {
    // The ordinary monorepo case: one shared test runner, two different
    // builds. Taking the whole block from whichever module sorted first would
    // give one module's build command to the other module's code.
    const { verification, conflicts } = chooseVerification([
      {
        verification: {
          testCommand: 'pnpm turbo test',
          buildCommand: 'pnpm --filter webapp build',
        },
      },
      {
        verification: {
          testCommand: 'pnpm turbo test',
          buildCommand: 'pnpm --filter server build',
        },
      },
    ]);

    expect(verification.testCommand).toBe('pnpm turbo test');
    expect(verification.buildCommand).toBeUndefined();
    expect(conflicts).toEqual(['buildCommand']);
  });

  it('unions setup commands instead of dropping them', () => {
    // Setup installs things. Two modules wanting two different installs both
    // want theirs to happen, and one extra install is not a wrong answer the
    // way one extra test command is.
    const { verification } = chooseVerification([
      { verification: { setupCommands: ['pnpm install'] } },
      { verification: { setupCommands: ['pnpm install', 'go mod download'] } },
    ]);

    expect(verification.setupCommands).toEqual([
      'pnpm install',
      'go mod download',
    ]);
  });

  it('says nothing when no module has been configured', () => {
    const { verification, conflicts } = chooseVerification([
      { verification: null },
      { verification: undefined },
    ]);

    expect(verification).toEqual({});
    expect(conflicts).toEqual([]);
  });

  it('ignores anything in the column that is not a command', () => {
    // Free-form JSON, so it may hold a past shape or a direct write. These
    // strings become commands the runner executes, so every field is checked.
    const { verification } = chooseVerification([
      {
        verification: {
          testCommand: 42,
          lintCommand: '',
          buildCommand: 'pnpm build',
          setupCommands: 'pnpm install',
        },
      },
    ]);

    expect(verification).toEqual({ buildCommand: 'pnpm build' });
  });

  it('ignores a column holding something that is not an object', () => {
    const { verification } = chooseVerification([
      { verification: 'pnpm test' },
      { verification: ['pnpm test'] },
    ]);

    expect(verification).toEqual({});
  });
});

describe('the hosts a module declares for its setup', () => {
  it('unions them across the issue’s modules', () => {
    // Unioned for the same reason setup commands are, plus one more: they
    // exist so those commands can succeed, and dropping them on disagreement
    // would union the installs and then block half of them.
    const { verification } = chooseVerification([
      { verification: { egressHosts: ['proxy.golang.org'] } },
      { verification: { egressHosts: ['pypi.org', 'proxy.golang.org'] } },
    ]);

    expect(verification.egressHosts).toEqual(['proxy.golang.org', 'pypi.org']);
  });

  it('drops anything that is not a bare hostname', () => {
    // These widen a sandbox's egress allowlist and the column is free-form
    // JSON, so a stored URL is refused rather than normalised into a host.
    const { verification } = chooseVerification([
      {
        verification: {
          egressHosts: ['good.example.com', 'https://evil.example/', '*', 42],
        },
      },
    ]);

    expect(verification.egressHosts).toEqual(['good.example.com']);
  });

  it('says nothing when no module asked for anything', () => {
    const { verification } = chooseVerification([
      { verification: { testCommand: 'go test ./...' } },
    ]);

    expect(verification.egressHosts).toBeUndefined();
  });
});
