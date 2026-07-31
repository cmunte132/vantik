import { VantikError } from '@vantikhq/agent-core';
import { Command } from 'commander';

import { resolveAgent } from '../utilities/agent';
import { chalkError } from '../utilities/cliOutput';
import {
  renderProject,
  renderProjectList,
  renderProjectRef,
} from '../utilities/projectOutput';
import { resolveBody } from '../utilities/stdin';

/**
 * Project commands, in the shape of `task.ts`: a neutral surface over
 * agent-core for a human at a terminal.
 *
 * Deliberately unopinionated. The view that projects should be few and
 * long-lived lives in the MCP tool descriptions and the skill, where a model
 * reads it; a person at a shell files what they want, and the CLI, agent-core
 * and the REST API underneath all stay mechanical.
 */

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

const DESCRIPTION_HELP =
  'Description (markdown); "-" reads it from stdin';

export function configureProjectCommands(program: Command) {
  const project = program
    .command('project')
    .description('Work Vantik projects from the terminal');

  project
    .command('list')
    .description('List the workspace’s projects')
    .option('--json', 'Output raw JSON')
    .action(async (options) => {
      await run(
        options.json,
        () => resolveAgent().listProjects(),
        renderProjectList,
      );
    });

  project
    .command('show')
    .description('Show one project, including its full description')
    .argument('<project>', 'Project name or id')
    .option('--json', 'Output raw JSON')
    .action(async (ref, options) => {
      await run(
        options.json,
        () => resolveAgent().getProject(ref),
        renderProject,
      );
    });

  project
    .command('create')
    .description('Open a project')
    .argument('<name...>', 'Project name')
    .option('-d, --description <markdown>', DESCRIPTION_HELP)
    .option('-s, --status <status>', 'Defaults to the first workspace status')
    .option('--start <date>', 'ISO start date')
    .option('--end <date>', 'ISO end date')
    .option('--json', 'Output raw JSON')
    .action(async (name, options) => {
      const description = await resolveBody(options.description);

      await run(
        options.json,
        () =>
          resolveAgent().createProject({
            name: name.join(' '),
            description,
            status: options.status,
            startDate: options.start,
            endDate: options.end,
          }),
        (created) => renderProjectRef(created, 'Created'),
      );
    });

  project
    .command('update')
    .description('Change a project’s fields')
    .argument('<project>', 'Project name or id')
    .option('--name <name>', 'New name')
    .option('-d, --description <markdown>', `New ${DESCRIPTION_HELP}`)
    .option('-s, --status <status>', 'e.g. Backlog, In Progress, Completed')
    .option('--start <date>', 'ISO start date')
    .option('--end <date>', 'ISO end date')
    .option('--lead <userId>', 'Member id of the project lead')
    .option('--json', 'Output raw JSON')
    .action(async (ref, options) => {
      const description = await resolveBody(options.description);

      await run(
        options.json,
        () =>
          resolveAgent().updateProject(ref, {
            name: options.name,
            description,
            status: options.status,
            startDate: options.start,
            endDate: options.end,
            leadUserId: options.lead,
          }),
        (updated) => renderProjectRef(updated, 'Updated'),
      );
    });

  return project;
}
