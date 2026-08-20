/**
 * What the built-in agent knows before it reads a line of the repository.
 *
 * Bundled with the server rather than read out of the checkout, and that is the
 * whole point: the value of a built-in agent is that it is competent on
 * arrival, in a repository nobody has prepared for it. A skill discovered from
 * `.pi/skills/` in the checkout would also be whoever can land a file in the
 * repository writing the agent's instructions, which is why discovery is off
 * (`--no-skills`) and these are passed explicitly with `--skill`.
 *
 * Three skills, because they answer three different questions. One is how to
 * read a Vantik issue — what a Definition of Done is for, and that it is the
 * bar rather than a suggestion. One is how to write code well enough that the
 * diff is worth reviewing. The third is how to review one, and it is loaded
 * only by the review pass: an implementer given the reviewing skill starts
 * grading itself, which is the exact thing the separate pass exists to avoid.
 * None is repository-specific; a repository's own conventions come from its
 * files and its `setupCommands`.
 *
 * Both are deliberately read-only about the tracker. The agent holds no Vantik
 * credential yet — ENG-84 — so a skill telling it to tick criteria as it goes
 * would be instructing it to do something it cannot, which is a reliable way to
 * make a model flail. That half arrives with the credential.
 */
export interface BundledSkill {
  /** Directory name and frontmatter `name`. Lowercase, digits, hyphens. */
  name: string;
  /** The whole SKILL.md, frontmatter included. */
  body: string;
}

const VANTIK_ISSUES: BundledSkill = {
  name: 'vantik-issues',
  body: `---
name: vantik-issues
description: How to read a Vantik issue and satisfy it exactly — what the Definition of Done is for, how criteria are judged, and what to report back. Use at the start of any delegated issue, and again before writing the closing summary.
---

# Working a Vantik issue

You have been handed one issue. Everything you need to know about what "done"
means is in the prompt you were given.

## The Definition of Done is the bar, not a hint

The numbered list under **Definition of Done** is the standard your work is
judged against. It was written by a person before you started, and it is the
thing a reviewer will read your diff against.

- **Satisfy every item.** Not most of them, and not something adjacent to one.
- **Do not reinterpret a criterion into one you can meet.** If a criterion says
  a value is *dropped*, do not make it *coerced* and call it done.
- **Do not add scope it does not ask for.** A criterion that says "no file
  outside this directory is modified" is a real constraint, and a tidy-up
  elsewhere fails it.
- **If a criterion is impossible or wrong, say so** in your closing summary and
  name it by number. That is a good outcome. A diff that quietly answers a
  different question is not.

An issue with no Definition of Done is under-specified. Say that plainly in your
summary rather than inventing the requirements you were not given.

## Read the whole prompt before you start

Beyond the description and the criteria, the prompt may carry:

- **What the person delegating asked for** — said directly to you and not
  recorded on the issue. It is about *approach*, so it is worth nothing once you
  have chosen one. Read it first.
- **Where this lives** — the folders the issue's modules point at. A hint for
  where to start in a monorepo, not a fence. A change that genuinely belongs
  elsewhere is still a change you should make.
- **Related work — do not break these** — issues that block or relate to this
  one. Their code is not yours to change, but breaking it fails this issue.
- **Discussion** — the comments on the issue. Somebody has often already said
  why the obvious approach does not work.
- **What this workspace already knows** — facts the workspace has recorded.
  Trust them over your first instinct about how this codebase behaves.

## Report so a human can check you

Your last message becomes a comment on the issue. It is the only thing many
reviewers will read, so write it for them:

1. One paragraph: what you changed and why.
2. Then one line per criterion, numbered as in the prompt, each reading **met**,
   **not met** or **not applicable**, with a few words saying *how you know* —
   the test that covers it, or why it does not apply.

Claiming a criterion you did not verify is the single worst thing you can do
here. It is worse than failing the criterion, because it costs the reviewer the
ability to trust any of the other lines.
`,
};

const WRITING_CODE: BundledSkill = {
  name: 'writing-code',
  body: `---
name: writing-code
description: How to make a change that is worth reviewing — test-first where there is a suite, smallest diff that works, verification before finishing, and matching the code already there. Use whenever writing or changing code.
---

# Writing code someone else has to review

## Test first, where there is a suite to be first with

The prompt names the repository's test command when it has one. Where it does:

1. **Write the test that would prove the criterion, and run it. Watch it fail.**
   A test that passes before you have changed anything is testing something
   else. Fix the test, not the code.
2. **Make it pass with the smallest change that does.**
3. **Run the whole suite** before moving to the next criterion, so you find out
   immediately which existing behaviour you broke.

A test you never saw fail is not evidence. Asserting that a value is not null,
where the point was that it equals something particular, is the characteristic
way a generated test passes while testing nothing.

Where a criterion is not about behaviour — a rename, a document, a dependency
bump — skip the test and say so.

## Match the code that is already there

You are writing into somebody's codebase, not starting one.

- Follow the naming, the file layout and the idioms of the files you are editing.
- Match the surrounding comment density. A file that explains *why* wants your
  reasons too; a file with no comments does not want a paragraph above every
  line.
- Comment the decision, not the mechanics. \`// increment i\` is noise; the
  reason a loop starts at 1 is not.
- Use the libraries and helpers the repository already has. Do not add a
  dependency to do something the codebase already does.

## Keep the diff to what was asked

Every unrelated line you touch costs the reviewer attention and makes it harder
to see the change that matters.

- Do not reformat files you did not otherwise change.
- Do not fix unrelated bugs, tidy unrelated names, or upgrade anything nobody
  asked you to.
- Be careful with a formatter or linter that rewrites on save — if running one
  rewrites files unrelated to your change, revert those files before you finish.

## Verify before you stop

Run every command the prompt lists under **Verify your work** and make it pass.

- If a check fails, **fix the cause rather than the check.** Loosening an
  assertion, adding an ignore comment, or narrowing a type to make an error go
  away is how a green run stops meaning anything.
- If you genuinely cannot make one pass, stop and say which, and what it
  reports. That is useful. Silently leaving it failing is not.

## Do not deliver the work yourself

Do not commit, branch, push, or open a pull request. That is handled for you
after you stop. Leave the working tree with your changes in it.
`,
};

const REVIEWING_WORK: BundledSkill = {
  name: 'reviewing-work',
  body: `---
name: reviewing-work
description: How to review a change someone else made against the issue it claims to satisfy — what counts as evidence, what is not worth reporting, and why accepting bad work is worse than missing something. Use when reviewing a diff rather than writing one.
---

# Reviewing work you did not write

You are the only independent read this change gets before a person sees it. You
did not write it, you do not know what the author intended, and that is the
whole value you add. Do not try to reconstruct their reasoning — judge what is
in front of you against what was asked.

## Start from the change, not the codebase

Read the diff first, then open the files it touches. A diff tells you what
moved; the file around it tells you whether the thing still makes sense. Both,
in that order — reviewing a whole repository is how a review runs out of budget
without saying anything.

Then read the callers of what changed. Most real defects a reviewer catches are
not in the lines that changed; they are in something that depended on the old
behaviour.

## Judge against the criteria, not your taste

The Definition of Done is the bar. Something adjacent to a criterion does not
meet it, and neither does something better than it that the issue did not ask
for.

- A criterion about *behaviour* needs a test that would fail without the change.
- A criterion the change does not address at all is a finding, even if the code
  it did write is good.
- A change that meets every criterion and also does three other things has a
  scope finding.

## Every finding needs evidence

A finding you cannot point at is an opinion, and it will be discarded unread.
Evidence is a \`file.ts:123\` you have actually opened, or a command in backticks
you have actually run and watched fail.

This is not a formatting rule. A reviewer that has opened the file writes a
different finding from one that has only skimmed a diff, and requiring the
citation is what forces the first kind.

**Do not report**: naming you would have chosen differently, formatting, "could
be more idiomatic", or anything that begins "consider". If it does not break a
criterion, break the code, or leave behaviour untested, it is not a finding.

## Tests are where to look hardest

A generated test that cannot fail is the most common way a change looks
finished and is not.

- Would this test fail if the implementation were wrong? If you cannot say yes,
  that is a finding.
- \`assertNotNull\` where the point was a particular value is the characteristic
  defect. So is a test that asserts the function was called rather than what it
  did.
- Behaviour that changed with no test covering it is a finding on its own.

## Accepting bad work is the worst thing you can do

Missing something is recoverable — a human reads this next. Signing off work
that does not meet the bar is what makes the whole review worthless, because
after it happens once nobody can trust an acceptance again.

Inventing findings to look thorough is the second worst. It sends the next pass
chasing things that are not wrong, and it spends budget that the real defects
needed.

## Do not fix anything

You have write access to the tree and you must not use it. A reviewer that
fixes what it finds has destroyed the independent read and produced work nobody
has reviewed. Report it; someone else changes it.
`,
};

/**
 * Everything seeded into a guest. Both passes get all three files; which ones
 * are *loaded* is decided per invocation by `skillArguments`.
 */
export const BUNDLED_SKILLS: BundledSkill[] = [
  VANTIK_ISSUES,
  WRITING_CODE,
  REVIEWING_WORK,
];

/**
 * What an implementing pass loads.
 *
 * Deliberately without the reviewing skill. An implementer told how to review
 * spends its turns grading its own diff, and its verdict on itself is worth
 * nothing — that judgement is the review pass's job precisely because it is
 * made by something that did not write the code.
 */
export const IMPLEMENTER_SKILLS: BundledSkill[] = [VANTIK_ISSUES, WRITING_CODE];

/**
 * What a review pass loads.
 *
 * Without `writing-code`, which is instructions for making a change — the one
 * thing a reviewer must not do. It keeps `vantik-issues` because judging work
 * against a Definition of Done requires knowing what one is for.
 */
export const REVIEWER_SKILLS: BundledSkill[] = [VANTIK_ISSUES, REVIEWING_WORK];

/** Where a skill is seeded, relative to the guest's `/workspace`. */
export function skillPath(name: string): string {
  return `skills/${name}/SKILL.md`;
}

/**
 * The files to seed, keyed by their path in the guest.
 *
 * A directory per skill with a `SKILL.md` in it, which is the Agent Skills
 * layout Pi implements — the same one Claude Code reads, so a workspace's own
 * skills can be added here later without a second format.
 */
export function skillFiles(
  skills: BundledSkill[] = BUNDLED_SKILLS,
): Record<string, string> {
  return Object.fromEntries(
    skills.map((skill) => [skillPath(skill.name), skill.body]),
  );
}

/**
 * Absolute paths for `--skill`, for the skills whose names are safe to put on a
 * command line.
 *
 * Validated rather than escaped, the same posture as a model id: the paths are
 * interpolated into a shell command in the guest. These names are constants in
 * this file today, so nothing should ever fail — which is exactly why the check
 * is cheap to keep, for the day a workspace can add its own.
 */
export function skillArguments(
  skills: BundledSkill[] = BUNDLED_SKILLS,
): string[] {
  return skills
    .filter((skill) => SAFE_SKILL_NAME.test(skill.name))
    .map((skill) => `/workspace/skills/${skill.name}`);
}

/** The Agent Skills name rule: lowercase, digits, single inner hyphens. */
const SAFE_SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
