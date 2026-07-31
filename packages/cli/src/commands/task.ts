import {
  VantikError,
  priorityNames,
  type PriorityName,
  type WorkflowCategory,
} from '@vantikhq/agent-core';
import { Command } from 'commander';

import { resolveAgent } from '../utilities/agent';
import { chalkError } from '../utilities/cliOutput';
import {
  renderAgentRun,
  renderAgentRuns,
  renderHits,
  renderList,
  renderNote,
  renderRef,
  renderTask,
} from '../utilities/taskOutput';

/**
 * Task commands: a neutral, ergonomic surface over agent-core for a human at a
 * terminal. Deliberately unopinionated — unlike the MCP tools and the skill,
 * these hold no view on whether an issue is "substantial enough". A person
 * files what they want; agent-core (and the REST API under it) stay neutral, so
 * the CLI does too.
 */

const CATEGORIES: WorkflowCategory[] = [
  'TRIAGE',
  'BACKLOG',
  'UNSTARTED',
  'STARTED',
  'COMPLETED',
  'CANCELED',
];

/** Prints the result as JSON when `--json` is set, otherwise via a renderer. */
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
      // agent-core error messages are written to be read as-is.
      // eslint-disable-next-line no-console
      console.error(`${chalkError('Error:')} ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

function asPriority(value: string | undefined): PriorityName | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!priorityNames.includes(value as PriorityName)) {
    throw new VantikError(
      `Unknown priority "${value}". Use one of: ${priorityNames.join(', ')}.`,
    );
  }
  return value as PriorityName;
}

function asCategories(
  values: string[] | undefined,
): WorkflowCategory[] | undefined {
  if (!values?.length) {
    return undefined;
  }
  const upper = values.map((value) => value.toUpperCase());
  const unknown = upper.filter(
    (value) => !CATEGORIES.includes(value as WorkflowCategory),
  );
  if (unknown.length) {
    throw new VantikError(
      `Unknown state ${unknown.length > 1 ? 'categories' : 'category'} ` +
        `${unknown.join(', ')}. Use one of: ${CATEGORIES.join(', ')}.`,
    );
  }
  return upper as WorkflowCategory[];
}

export function configureTaskCommands(program: Command) {
  const task = program
    .command('task')
    .description('Work Vantik issues from the terminal');

  task
    .command('list')
    .description('List tasks, newest first')
    .option('-t, --team <team>', 'Team identifier, e.g. ENG')
    .option('-a, --assignee <who>', 'Member email, name, or "me"')
    .option('-c, --category <category...>', 'Workflow categories to include')
    .option('--label <label...>', 'Labels to include')
    .option('-p, --priority <priority>', 'none | urgent | high | medium | low')
    .option('--project <project>', 'Only tasks in this project')
    .option('--product <product>', 'Only tasks touching this product’s modules')
    .option('--module <module...>', 'Only tasks touching these modules')
    .option('--capability <capability>', 'Only tasks delivering this capability')
    .option('-n, --limit <n>', 'Rows per page', (v) => parseInt(v, 10))
    .option('--json', 'Output raw JSON')
    .action(async (options) => {
      await run(
        options.json,
        () =>
          resolveAgent().listTasks({
            team: options.team,
            assignee: options.assignee,
            stateCategory: asCategories(options.category),
            labels: options.label,
            priority: asPriority(options.priority),
            project: options.project,
            product: options.product,
            modules: options.module,
            capability: options.capability,
            perPage: options.limit,
          }),
        renderList,
      );
    });

  task
    .command('get')
    .description(
      'Show one task in full: description, notes, history, relations',
    )
    .argument('<task>', 'Task key (ENG-42) or id')
    .option('--json', 'Output raw JSON')
    .action(async (ref, options) => {
      await run(options.json, () => resolveAgent().getTask(ref), renderTask);
    });

  task
    .command('search')
    .description('Search titles, descriptions and notes')
    .argument('<query...>', 'Free text')
    .option('-c, --category <category...>', 'Restrict to these categories')
    .option('-n, --limit <n>', 'Max hits', (v) => parseInt(v, 10))
    .option('--json', 'Output raw JSON')
    .action(async (query, options) => {
      await run(
        options.json,
        () =>
          resolveAgent().searchTasks({
            query: query.join(' '),
            stateCategory: asCategories(options.category),
            limit: options.limit,
          }),
        renderHits,
      );
    });

  task
    .command('similar')
    .description('Prior tasks resembling one, with how each was resolved')
    .argument('<task>', 'Task key or id')
    .option('--json', 'Output raw JSON')
    .action(async (ref, options) => {
      await run(
        options.json,
        () => resolveAgent().findSimilarTasks(ref),
        renderHits,
      );
    });

  task
    .command('create')
    .description('Create a task')
    .argument('<title...>', 'Task title')
    .option('-d, --description <markdown>', 'Description (markdown)')
    .option('-t, --team <team>', 'Team identifier, e.g. ENG')
    .option(
      '-s, --state <state>',
      'State name or category; defaults to backlog',
    )
    .option('--label <label...>', 'Labels')
    .option('-p, --priority <priority>', 'none | urgent | high | medium | low')
    .option('-a, --assignee <who>', 'Member email, name, or "me"')
    .option('--parent <task>', 'Create as a sub-task of this task')
    .option('--project <project>', 'File under this project')
    .option('--module <module...>', 'Modules this task changes')
    .option('--capability <capability>', 'Capability this task delivers')
    .option('--json', 'Output raw JSON')
    .action(async (title, options) => {
      await run(
        options.json,
        () =>
          resolveAgent().createTask({
            title: title.join(' '),
            description: options.description,
            team: options.team,
            state: options.state,
            labels: options.label,
            priority: asPriority(options.priority),
            assignee: options.assignee,
            parent: options.parent,
            project: options.project,
            moduleIds: options.module,
            capability: options.capability,
          }),
        (ref) => renderRef(ref, 'Created'),
      );
    });

  task
    .command('update')
    .description('Change a task’s fields')
    .argument('<task>', 'Task key or id')
    .option('--title <title>', 'New title')
    .option('-d, --description <markdown>', 'New description (markdown)')
    .option('-s, --state <state>', 'State name or category')
    .option('--label <label...>', 'Replace labels')
    .option('-p, --priority <priority>', 'none | urgent | high | medium | low')
    .option('-a, --assignee <who>', 'Member email, name, or "me"')
    .option('--project <project>', 'Move under this project')
    .option('--module <module...>', 'Replace the modules this task changes')
    .option('--capability <capability>', 'Capability this task delivers')
    .option('--no-capability', 'Clear the capability')
    .option('--json', 'Output raw JSON')
    .action(async (ref, options) => {
      await run(
        options.json,
        () =>
          resolveAgent().updateTask(ref, {
            title: options.title,
            description: options.description,
            state: options.state,
            labels: options.label,
            priority: asPriority(options.priority),
            assignee: options.assignee,
            project: options.project,
            moduleIds: options.module,
            // Commander turns --no-capability into `false`, which is how
            // clearing the field is told apart from leaving it alone. Anything
            // else is passed through, including undefined for "not mentioned".
            ...(options.capability === false
              ? { capability: null }
              : options.capability
                ? { capability: options.capability }
                : {}),
          }),
        (updated) => renderRef(updated, 'Updated'),
      );
    });

  task
    .command('pick-up')
    .description('Assign a task and move it into the in-progress state')
    .argument('<task>', 'Task key or id')
    .option('-a, --assignee <who>', 'Defaults to the token owner')
    .option('--json', 'Output raw JSON')
    .action(async (ref, options) => {
      await run(
        options.json,
        () => resolveAgent().pickUpTask(ref, { assignee: options.assignee }),
        (picked) => renderRef(picked, 'Picked up'),
      );
    });

  task
    .command('note')
    .description('Post a markdown note on a task')
    .argument('<task>', 'Task key or id')
    .argument('<body...>', 'Note body (markdown)')
    .option('--json', 'Output raw JSON')
    .action(async (ref, body, options) => {
      await run(
        options.json,
        () => resolveAgent().addNote(ref, body.join(' ')),
        renderNote,
      );
    });

  task
    .command('delegate')
    .description('Hand a task to an agent to work in the background')
    .argument('<task>', 'Task key or id')
    .option('--agent <agent>', 'Agent account id; omit if there is only one')
    .option('--executor <executor>', 'Backend key, e.g. byo')
    .option('--repo <path>', 'Local repository to work in')
    .option('--repo-url <url>', 'Remote to clone instead of a local path')
    .option('-b, --base <branch>', 'Base branch')
    .option('--test <command>', 'How to run the tests')
    .option('--lint <command>', 'How to run the linter')
    .option('--typecheck <command>', 'How to typecheck')
    .option('--force', 'Start even if this task already has a live run')
    .option('--json', 'Output raw JSON')
    .action(async (ref, options) => {
      await run(
        options.json,
        () =>
          resolveAgent().delegateTask(ref, {
            agent: options.agent,
            executor: options.executor,
            force: options.force,
            repo: {
              repoPath: options.repo,
              repoUrl: options.repoUrl,
              baseBranch: options.base,
              testCommand: options.test,
              lintCommand: options.lint,
              typecheckCommand: options.typecheck,
            },
          }),
        renderAgentRun,
      );
    });

  task
    .command('runs')
    .description('Show every agent run for a task, newest first')
    .argument('<task>', 'Task key or id')
    .option('--json', 'Output raw JSON')
    .action(async (ref, options) => {
      await run(
        options.json,
        () => resolveAgent().listAgentRuns(ref),
        renderAgentRuns,
      );
    });

  task
    .command('close')
    .description('Close a task, recording how it was resolved')
    .argument('<task>', 'Task key or id')
    .option('-r, --resolution <markdown>', 'How it was resolved (markdown)')
    .option('-s, --state <state>', 'Override the completed state, e.g. Shipped')
    .option('--json', 'Output raw JSON')
    .action(async (ref, options) => {
      await run(
        options.json,
        () =>
          resolveAgent().closeTask(ref, {
            resolution: options.resolution,
            state: options.state,
          }),
        (closed) => renderRef(closed, 'Closed'),
      );
    });

  return task;
}
