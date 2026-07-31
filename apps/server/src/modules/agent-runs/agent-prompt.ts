import type { ContextPack } from './context-pack.service';

/**
 * What the agent is actually told.
 *
 * Rendered here, from the pack, rather than by each executor. The hosted
 * sandbox used to hand Pi the pack as a JSON file on stdin and the BYO runner
 * built prose of its own, which meant the same issue delegated two ways was
 * two different instructions — and the sandbox's was not an instruction at
 * all, because a pretty-printed object is not something a harness reads as a
 * prompt. One renderer, on the side that owns the pack, is the only
 * arrangement where "what was the agent told" has a single answer.
 *
 * The Definition of Done goes in as a numbered list rather than prose, because
 * it is the standard the work is judged against and a criterion the agent can
 * point at is more useful than a paragraph it can paraphrase. The verification
 * commands are stated as instructions rather than offered as options — an
 * agent that does not run the tests is the failure mode this whole design is
 * arranged to avoid.
 */
export function buildAgentPrompt(pack: ContextPack): string {
  const parts: string[] = [
    `You are working on ${pack.issue.key}: ${pack.issue.title}`,
    '',
    pack.issue.description || '(no description)',
  ];

  // Where in the tree to start, from the modules the issue names. Said as a
  // hint and not as a boundary: a monorepo is most of the reason an agent
  // wastes its first minutes, and a change that genuinely belongs elsewhere is
  // still a change it should make.
  if (pack.repo?.pathPrefixes?.length) {
    parts.push(
      '',
      '## Where this lives',
      '',
      `This issue is about ${pack.repo.pathPrefixes.join(', ')} in this repository. Start there.`,
    );
  }

  // Above the Definition of Done on purpose. It is how the person wants the
  // work approached, and an instruction about approach is worth nothing once
  // the approach has been chosen.
  if (pack.guidance) {
    parts.push(
      '',
      '## What the person delegating asked for',
      '',
      'Said directly to you, and not recorded on the issue. Follow it:',
      '',
      pack.guidance,
    );
  }

  const open = (pack.definitionOfDone ?? []).filter(
    (criterion) => !criterion.completed,
  );

  if (open.length) {
    parts.push(
      '',
      '## Definition of Done',
      '',
      'This is the standard your work is judged against. Satisfy every item:',
      '',
      ...open.map((criterion, index) => `${index + 1}. ${criterion.body}`),
      '',
      'Do not reinterpret these, and do not settle for something adjacent to ' +
        'one. If a criterion turns out to be impossible or wrong, say so in ' +
        'your closing summary and name it by number — that is a far better ' +
        'outcome than a diff that quietly answers a different question.',
    );
  }

  if (pack.subTasks?.length) {
    parts.push(
      '',
      '## Sub-tasks',
      '',
      ...pack.subTasks.map(
        (sub) => `- ${sub.done ? '[x]' : '[ ]'} ${sub.key} ${sub.title}`,
      ),
    );
  }

  if (pack.relations?.length) {
    parts.push(
      '',
      '## Related work — do not break these',
      '',
      ...pack.relations.map(
        (relation) => `- ${relation.type} ${relation.key}: ${relation.title}`,
      ),
    );
  }

  if (pack.comments?.length) {
    parts.push(
      '',
      '## Discussion',
      '',
      ...pack.comments
        .slice(-10)
        .map(
          (comment) => `**${comment.author ?? 'someone'}**: ${comment.body}`,
        ),
    );
  }

  if (pack.knowledge?.length) {
    parts.push(
      '',
      '## What this workspace already knows',
      '',
      ...pack.knowledge.map((entry) => `- (${entry.scope}) ${entry.body}`),
    );
  }

  const commands = verificationCommands(pack);

  // Test-first, and only where there is a suite to be first with. Telling an
  // agent to write a failing test in a repository whose test command we do not
  // know produces a file it invents a runner for, which is worse than no test
  // — so the instruction appears exactly when it can be acted on.
  if (pack.repo?.testCommand) {
    parts.push(
      '',
      '## How to work',
      '',
      'Test first. For each criterion above that describes behaviour:',
      '',
      '1. Write the test that would prove it, and run it. Watch it fail. A ' +
        'test that passes before you have changed anything is testing ' +
        'something else — fix the test, not the code.',
      '2. Make it pass with the smallest change that does.',
      '3. Run the whole suite before moving to the next criterion.',
      '',
      'Where a criterion is not about behaviour — a rename, a doc, a ' +
        'dependency — skip the test and say so in your summary.',
    );
  }

  if (commands.length) {
    parts.push(
      '',
      '## Verify your work',
      '',
      'Run these and make them pass before you finish. If one fails, fix the',
      'cause rather than the check:',
      '',
      ...commands.map(([label, command]) => `- ${label}: \`${command}\``),
    );
  }

  parts.push(
    '',
    '## How to finish',
    '',
    'Make the change, run the verification above, and stop. Do not commit,',
    'branch, push, or open a pull request — that is handled for you. Do not',
    'edit unrelated files.',
    '',
    'Close with a short report for the human who reviews this, in this shape:',
    '',
    '- One paragraph on what you changed and why.',
    '- Then a line per Definition of Done item, numbered as above, each',
    '  reading `met`, `not met` or `not applicable`, with a handful of words',
    '  saying how you know — the test that covers it, or why it does not',
    '  apply. Claiming an item you did not verify is the one thing that makes',
    '  this whole report worthless.',
  );

  return parts.join('\n');
}

/** The repo's own checks, in the order a reader expects them. */
function verificationCommands(pack: ContextPack): Array<[string, string]> {
  return Object.entries({
    Tests: pack.repo?.testCommand,
    Typecheck: pack.repo?.typecheckCommand,
    Lint: pack.repo?.lintCommand,
    Build: pack.repo?.buildCommand,
  }).filter((entry): entry is [string, string] => Boolean(entry[1]));
}
