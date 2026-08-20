import type { ContextPack } from './context-pack.service';
import type { ReviewFinding } from './review-cycle';

import { openCriteria, verificationCommands } from './agent-prompt';
import { reviewVerdictPath } from './review-cycle';
import { TREE_DIFF_COMMAND } from './sandbox/tree-tools';

/**
 * What the reviewer and the reviser are told.
 *
 * A separate agent with a separate prompt, not the implementer asked to think
 * again. That distinction is the entire point of the phase. An agent asked to
 * re-examine its own answer measures flat to negative on code generation and
 * will abandon a correct answer when challenged; an agent that has never seen
 * the reasoning, and is handed the issue and the resulting tree, is doing a
 * different job — the one a human reviewer does.
 *
 * So the reviewer is given:
 *
 * - the issue and its Definition of Done, numbered identically to the
 *   implementer's prompt, so a finding can name a criterion;
 * - the diff against the base tree, because reviewing a directory is not
 *   reviewing a change;
 * - the result of the repository's own checks, already run, as fact — no
 *   phase's opinion counts until something has been executed;
 * - and no instruction whatsoever about what the implementer intended, because
 *   the whole value is an opinion formed without it.
 */

export interface ReviewContext {
  /** 1-based, and the same number the verdict file carries. */
  pass: number;
  /** The repository's own checks, already run by the executor. */
  verification: VerificationOutcome[];
}

export interface VerificationOutcome {
  label: string;
  command: string;
  ok: boolean;
  /** Tail of the output. Present for a check that failed. */
  output?: string;
}

export function buildReviewPrompt(
  pack: ContextPack,
  context: ReviewContext,
): string {
  const criteria = openCriteria(pack);

  const parts: string[] = [
    `You are reviewing someone else's work on ${pack.issue.key}: ${pack.issue.title}`,
    '',
    'You did not write this change and you are not going to fix it. Your job is',
    'to decide whether it does what the issue asked, and to say precisely where',
    'it does not.',
    '',
    '## The issue',
    '',
    pack.issue.description || '(no description)',
  ];

  if (criteria.length) {
    parts.push(
      '',
      '## Definition of Done',
      '',
      'This is the standard the work is judged against — not your own taste, and',
      'not what you would have built:',
      '',
      ...criteria.map((criterion, index) => `${index + 1}. ${criterion.body}`),
    );
  }

  if (pack.guidance) {
    parts.push(
      '',
      '## What the person delegating asked for',
      '',
      pack.guidance,
    );
  }

  if (pack.relations?.length) {
    parts.push(
      '',
      '## Related work the change must not break',
      '',
      ...pack.relations.map(
        (relation) => `- ${relation.type} ${relation.key}: ${relation.title}`,
      ),
    );
  }

  parts.push(
    '',
    '## What was actually run',
    '',
    ...verificationReport(context),
  );

  parts.push(
    '',
    '## How to look at the change',
    '',
    `The repository is at \`/workspace/repo\`. An unmodified copy of what it`,
    `looked like before the work started is at \`/workspace/base\`. There is no`,
    'git in this sandbox, so:',
    '',
    '```sh',
    TREE_DIFF_COMMAND,
    '```',
    '',
    'prints the change. Start there, then open the files it names — a diff shows',
    'you what moved, not whether the thing around it still makes sense. Read the',
    'tests it added and ask whether they would fail if the implementation were',
    'wrong; a test that asserts a value is not null, where the point was that it',
    'equals something particular, passes while testing nothing.',
    '',
    'You may run the repository’s commands to check something for yourself.',
    'Do not edit, create or delete a single file in `/workspace/repo`. A reviewer',
    'that fixes what it finds destroys the only independent read anybody gets.',
  );

  parts.push(
    '',
    '## What to look for',
    '',
    '1. **Does it satisfy each criterion above?** Something adjacent to a',
    '   criterion does not satisfy it. If a criterion says a value is *dropped*,',
    '   a change that *coerces* it fails.',
    '2. **Is it tested where it should be?** Behaviour that changed with no test',
    '   covering it is a finding. So is a test that cannot fail.',
    '3. **Does it break anything it touched?** Look at the callers of what it',
    '   changed, not just the change.',
    '4. **Is there scope nobody asked for?** Unrelated reformatting, drive-by',
    '   fixes and new dependencies are findings.',
    '',
    'Do not report style preferences, naming you would have chosen differently,',
    'or anything you cannot point at. A finding you cannot evidence is noise that',
    'costs the next pass its budget.',
  );

  parts.push(
    '',
    '## How to answer',
    '',
    `Write your verdict to \`${reviewVerdictPath(context.pass)}\` as JSON, and`,
    'nothing else to that path:',
    '',
    '```json',
    '{',
    '  "accepted": false,',
    '  "summary": "One or two sentences on the state of the work.",',
    '  "findings": [',
    '    {',
    '      "message": "What is wrong, stated so someone can fix it.",',
    '      "evidence": "src/thing.ts:42",',
    '      "severity": "high",',
    '      "criterion": 2',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    '- `accepted` is `true` only if you would let this reach a human reviewer as',
    '  it stands. Every criterion met, checks passing, nothing blocking left.',
    '- **Every finding needs `evidence`**: a `file.ts:123` you have looked at, or',
    '  a command in backticks that fails. Findings without it are discarded',
    '  unread, so one you cannot evidence is one you did not report.',
    '- `severity` is `high` when it blocks acceptance, `medium` when it should be',
    '  fixed, `low` when it is a note. A `high` finding and `"accepted": true`',
    '  contradict each other, and the finding is what will be believed.',
    '- `criterion` is the number from the Definition of Done above, when the',
    '  finding is about one.',
    '',
    'Accepting work that does not meet the bar is the worst outcome available to',
    'you. Inventing findings to look thorough is the second worst — it sends the',
    'next pass chasing things that are not wrong.',
  );

  return parts.join('\n');
}

/**
 * What the implementer is told on the second and later passes.
 *
 * Carries the issue again rather than assuming the agent remembers it: this is
 * a fresh process with no memory of the first pass, and an agent handed only a
 * findings list will fix the findings while quietly drifting off the issue.
 */
export function buildRevisionPrompt(input: {
  pack: ContextPack;
  pass: number;
  findings: ReviewFinding[];
  verification: VerificationOutcome[];
  reviewSummary?: string;
}): string {
  const { pack, findings, verification, reviewSummary } = input;
  const criteria = openCriteria(pack);

  const parts: string[] = [
    `You are continuing work on ${pack.issue.key}: ${pack.issue.title}`,
    '',
    'A first attempt at this issue is already in the working tree at',
    '`/workspace/repo`, and a reviewer has been over it. Your job is to fix what',
    'the reviewer found — not to start again, and not to rewrite what is already',
    'right.',
    '',
    '## The issue',
    '',
    pack.issue.description || '(no description)',
  ];

  if (criteria.length) {
    parts.push(
      '',
      '## Definition of Done',
      '',
      'Unchanged, and still the standard. The numbering matches the findings',
      'below:',
      '',
      ...criteria.map((criterion, index) => `${index + 1}. ${criterion.body}`),
    );
  }

  if (reviewSummary) {
    parts.push('', '## What the reviewer said', '', reviewSummary);
  }

  // A pass can be asked for with no findings at all: the reviewer rejected the
  // work without citing anything, but the repository's own checks are red,
  // which is specific enough to act on. Printing the heading with nothing under
  // it would read to a model as an instruction it failed to receive.
  if (findings.length) {
    parts.push(
      '',
      '## What to fix',
      '',
      'Each of these cites the file and line it is about. Work through them:',
      '',
      ...findings.map((finding, index) => renderFinding(finding, index + 1)),
      '',
      'If a finding is wrong — the reviewer misread the code, or asked for',
      'something the issue does not — do not change the code to satisfy it. Say',
      'so in your closing summary, name it by number, and say why. That is a',
      'better outcome than a change made to silence a review.',
    );
  }

  const failed = verification.filter((check) => !check.ok);

  if (failed.length) {
    parts.push(
      '',
      '## Checks that are currently failing',
      '',
      ...failed.map(
        (check) =>
          `- **${check.label}** (\`${check.command}\`)${
            check.output
              ? `\n\n\`\`\`\n${check.output.slice(-1200)}\n\`\`\``
              : ''
          }`,
      ),
      '',
      'Fix the cause rather than the check. Loosening an assertion or adding an',
      'ignore comment to make one of these pass is how a green run stops meaning',
      'anything, and the next reviewer will find it.',
    );
  }

  const commands = verificationCommands(pack);

  if (commands.length) {
    parts.push(
      '',
      '## Verify before you stop',
      '',
      ...commands.map(([label, command]) => `- ${label}: \`${command}\``),
    );
  }

  parts.push(
    '',
    '## How to finish',
    '',
    findings.length
      ? 'Keep the diff to what the findings ask for.'
      : 'Keep the diff to what it takes to make the checks pass.',
    'Do not commit, branch, push or open a pull request — that is handled for',
    'you.',
    '',
    ...(findings.length
      ? [
          'Close with a short report: what you changed this pass, then a line per',
          'finding above, numbered as above, reading `fixed`, `not fixed` or',
          '`disagree`, with a handful of words saying how you know.',
        ]
      : [
          'Close with a short report: what you changed this pass, and which of the',
          'failing checks now pass. If one still does not, say which and what it',
          'reports — that is useful, and silently leaving it failing is not.',
        ]),
  );

  return parts.join('\n');
}

function renderFinding(finding: ReviewFinding, index: number): string {
  const tags = [
    finding.severity ? finding.severity : null,
    finding.criterion ? `criterion ${finding.criterion}` : null,
  ].filter(Boolean);

  return [
    `${index}. ${finding.message}`,
    finding.evidence ? `   - where: ${finding.evidence}` : null,
    tags.length ? `   - ${tags.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The checks, as something already true rather than something to go and do.
 *
 * Stated as fact because it is: the executor ran them before the reviewer was
 * started. This is the execution-grounded signal the whole phase rests on, and
 * a reviewer that has it argues about the code instead of speculating about
 * whether it works.
 */
function verificationReport(context: ReviewContext): string[] {
  if (context.verification.length === 0) {
    return [
      'This repository declares no test, lint, typecheck or build command, so',
      'nothing could be run against the change. That makes your read the only',
      'check there is — and it also means "there is no way to verify this" is a',
      'legitimate finding about the repository, worth saying once.',
    ];
  }

  const lines = context.verification.map(
    (check) =>
      `- **${check.label}** (\`${check.command}\`): ${check.ok ? 'passed' : 'FAILED'}`,
  );

  const failed = context.verification.filter((check) => !check.ok);

  if (failed.length === 0) {
    return [
      'The repository’s own checks were run against this tree just now:',
      '',
      ...lines,
      '',
      'Passing checks are not the same as satisfying the issue. They mean the',
      'change is not obviously broken, which is where your read starts.',
    ];
  }

  return [
    'The repository’s own checks were run against this tree just now:',
    '',
    ...lines,
    '',
    'Output from what failed:',
    '',
    ...failed.flatMap((check) => [
      `**${check.label}**`,
      '',
      '```',
      (check.output ?? '(no output captured)').slice(-1500),
      '```',
      '',
    ]),
    'A failing check is a finding on its own, and you should report it as one',
    'with the command as its evidence.',
  ];
}
