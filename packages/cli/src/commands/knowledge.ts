import {
  VantikError,
  type EntryPolicy,
  type EntryStatus,
} from '@vantikhq/agent-core';
import { Command } from 'commander';

import { resolveAgent } from '../utilities/agent';
import { configureKnowledgeSyncCommands } from './knowledge-sync';
import { chalkError } from '../utilities/cliOutput';
import {
  renderContextPack,
  renderEntries,
  renderGaps,
  renderHits,
  renderPage,
  renderPageList,
  renderPageRef,
  renderRemember,
  renderTriage,
} from '../utilities/knowledgeOutput';

/**
 * Knowledge commands: a neutral, scriptable surface over agent-core.
 *
 * Deliberately unopinionated, exactly like the task commands. The MCP tools and
 * the companion skill hold the view about when to append rather than create,
 * and about what makes one fact rather than six; a person at a terminal is
 * simply given the mechanism.
 *
 * Note the distinction that matters here: the *mechanical* limits — a page's
 * entry policy and the per-token budget on untriaged entries — live on the
 * server and do apply to this surface. They are arithmetic, not editorial, and
 * they cannot be bypassed by a client that ignores tool descriptions. That is
 * the whole reason they are not in the tool descriptions.
 */

const STATUSES: EntryStatus[] = [
  'PROPOSED',
  'STANDING',
  'CONSOLIDATED',
  'SUPERSEDED',
  'DISPUTED',
  'ARCHIVED',
];

const POLICIES: EntryPolicy[] = ['OPEN', 'CURATED', 'LOCKED'];

async function run<T>(
  json: boolean | undefined,
  work: () => Promise<T>,
  render: (value: T) => string,
): Promise<void> {
  try {
    const value = await work();
    // eslint-disable-next-line no-console
    console.log(json ? JSON.stringify(value, null, 2) : render(value));
  } catch (error) {
    if (error instanceof VantikError) {
      // agent-core error messages are written to be read as-is — including the
      // budget refusal, which names the entries standing in the way.
      // eslint-disable-next-line no-console
      console.error(`${chalkError('Error:')} ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

function asStatuses(values: string[] | undefined): EntryStatus[] | undefined {
  if (!values?.length) {
    return undefined;
  }

  const upper = values.map((value) => value.toUpperCase());
  const unknown = upper.filter(
    (value) => !STATUSES.includes(value as EntryStatus),
  );

  if (unknown.length) {
    throw new VantikError(
      `Unknown ${unknown.length > 1 ? 'statuses' : 'status'} ` +
        `${unknown.join(', ')}. Use one of: ${STATUSES.join(', ')}.`,
    );
  }

  return upper as EntryStatus[];
}

function asStatus(value: string): EntryStatus {
  const upper = value.toUpperCase();

  if (!STATUSES.includes(upper as EntryStatus)) {
    throw new VantikError(
      `Unknown status "${value}". Use one of: ${STATUSES.join(', ')}.`,
    );
  }

  return upper as EntryStatus;
}

function asPolicy(value: string | undefined): EntryPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }

  const upper = value.toUpperCase();
  if (!POLICIES.includes(upper as EntryPolicy)) {
    throw new VantikError(
      `Unknown entry policy "${value}". Use one of: ${POLICIES.join(', ')}.`,
    );
  }

  return upper as EntryPolicy;
}

export function configureKnowledgeCommands(program: Command) {
  const knowledge = program
    .command('knowledge')
    .alias('kb')
    .description('Read and write the workspace knowledge bank');

  knowledge
    .command('pages')
    .description('List knowledge pages as a tree')
    .option('--json', 'Output raw JSON')
    .action(async (options) => {
      await run(options.json, () => resolveAgent().listPages(), renderPageList);
    });

  knowledge
    .command('show')
    .description('Show a page: body, breadcrumb, and its standing facts')
    .argument('<page>', 'Page title or id')
    .option('--json', 'Output raw JSON')
    .action(async (page, options) => {
      await run(options.json, () => resolveAgent().readPage(page), renderPage);
    });

  knowledge
    .command('search')
    .description('Search page bodies and standing facts')
    .argument('<query...>', 'Free text')
    .option('-s, --scope <scope>', 'Narrow to a repo path, team or project')
    .option('-n, --limit <n>', 'Max hits', (v) => parseInt(v, 10))
    .option('--json', 'Output raw JSON')
    .action(async (query, options) => {
      await run(
        options.json,
        () =>
          resolveAgent().recallKnowledge({
            query: query.join(' '),
            scope: options.scope,
            limit: options.limit,
          }),
        renderHits,
      );
    });

  knowledge
    .command('context')
    .description('Load what matters for a piece of work, under a token budget')
    .option('-s, --scope <scope>', 'Where you are working')
    .option('-t, --task <task>', 'What you are about to do')
    .option('-b, --budget <tokens>', 'Token budget', (v) => parseInt(v, 10))
    .option('--json', 'Output raw JSON')
    .action(async (options) => {
      await run(
        options.json,
        () =>
          resolveAgent().loadContext({
            scope: options.scope,
            task: options.task,
            tokenBudget: options.budget,
          }),
        renderContextPack,
      );
    });

  knowledge
    .command('append')
    .description('Append one asserted fact to a page')
    .argument('<page>', 'Page title or id')
    .argument('<content...>', 'The fact, in markdown')
    .option('-s, --scope <scope>', 'Where the fact applies')
    .option('--session <id>', 'Harness session id, for provenance')
    .option('--supersedes <entryId>', 'The entry this one replaces')
    .option(
      '--distinct',
      'Append even though similar entries exist. Without it, a write with ' +
        'near matches returns them and writes nothing.',
    )
    .option('--json', 'Output raw JSON')
    .action(async (page, content, options) => {
      await run(
        options.json,
        () =>
          resolveAgent().remember({
            page,
            content: content.join(' '),
            scope: options.scope,
            session: options.session,
            supersedes: options.supersedes,
            distinct: options.distinct,
          }),
        renderRemember,
      );
    });

  knowledge
    .command('write')
    .description('Create a page, or rewrite the body of an existing one')
    .argument('<title...>', 'Page title')
    .option('-b, --body <markdown>', 'Page body')
    .option('-p, --parent <page>', 'Nest under this page')
    .option('--policy <policy>', 'OPEN | CURATED | LOCKED')
    .option('--json', 'Output raw JSON')
    .action(async (title, options) => {
      await run(
        options.json,
        () =>
          resolveAgent().writePage({
            title: title.join(' '),
            body: options.body,
            parent: options.parent,
            entryPolicy: asPolicy(options.policy),
          }),
        (page) => renderPageRef(page, 'Wrote'),
      );
    });

  knowledge
    .command('entries')
    .description('List a page’s entries, optionally by status')
    .argument('<page>', 'Page title or id')
    .option('--status <status...>', 'PROPOSED, STANDING, DISPUTED, …')
    .option('--json', 'Output raw JSON')
    .action(async (page, options) => {
      await run(
        options.json,
        () => resolveAgent().listEntries(page, asStatuses(options.status)),
        renderEntries,
      );
    });

  knowledge
    .command('triage')
    .description('Apply one status decision to a set of entries')
    .argument('<status>', 'STANDING, DISPUTED, ARCHIVED, …')
    .argument('<entryIds...>', 'Entry ids')
    .option('--json', 'Output raw JSON')
    .action(async (status, entryIds, options) => {
      await run(
        options.json,
        () =>
          resolveAgent().triageEntries({
            entryIds,
            status: asStatus(status),
          }),
        renderTriage,
      );
    });

  knowledge
    .command('consolidate')
    .description('Fold standing facts into a page body and mark them folded')
    .argument('<page>', 'Page title or id')
    .requiredOption('-b, --body <markdown>', 'The rewritten page body')
    .option('--entry <entryId...>', 'Entries to fold; omit to fold all standing')
    .option('--json', 'Output raw JSON')
    .action(async (page, options) => {
      await run(
        options.json,
        () =>
          resolveAgent().consolidate({
            page,
            body: options.body,
            entryIds: options.entry,
          }),
        (result) => renderPageRef(result, 'Consolidated into'),
      );
    });

  // Pull, push and generate: the same bank as plain markdown on disk, for
  // harnesses that read files rather than speaking MCP.
  configureKnowledgeSyncCommands(knowledge);

  knowledge
    .command('gaps')
    .description('Questions the bank could not answer, most-asked first')
    .option('--json', 'Output raw JSON')
    .action(async (options) => {
      await run(options.json, () => resolveAgent().knowledgeGaps(), renderGaps);
    });
}
