import { Command } from 'commander';

import { resolveAgent } from '../utilities/agent';
import { chalkError } from '../utilities/cliOutput';
import {
  renderCapabilities,
  renderModules,
  renderProducts,
} from '../utilities/taskOutput';

/**
 * The product axis, read-only from the terminal.
 *
 * A team says who works on something; this axis says what the software is made
 * of and what it does. These commands answer the two questions a person has
 * before filing or picking up work: which module am I in, and does a capability
 * for this already exist.
 *
 * Reading only, on purpose. A workspace's map is drawn in the app, by the
 * people who own the code, and a map edited from a script is one nobody trusts.
 */

/** Prints the result as JSON when `--json` is set, otherwise via a renderer. */
async function run<T>(
  json: boolean | undefined,
  work: () => Promise<T>,
  render: (value: T) => string,
): Promise<void> {
  try {
    const value = await work();
    console.log(json ? JSON.stringify(value, null, 2) : render(value));
  } catch (error) {
    console.error(
      chalkError(error instanceof Error ? error.message : String(error)),
    );
    process.exitCode = 1;
  }
}

export function configureProductAxisCommands(program: Command) {
  program
    .command('products')
    .description('What this workspace ships')
    .option('--json', 'Output raw JSON')
    .action(async (options) => {
      await run(
        options.json,
        () => resolveAgent().listProducts(),
        renderProducts,
      );
    });

  program
    .command('modules')
    .description('Where the code is, with the repositories each module sits in')
    .option(
      '--no-repos',
      'Skip the repositories, which cost one request per module',
    )
    .option('--json', 'Output raw JSON')
    .action(async (options) => {
      await run(
        options.json,
        () => resolveAgent().listModules({ withRepos: options.repos !== false }),
        renderModules,
      );
    });

  program
    .command('capabilities')
    .description('What the software does for the people who use it')
    .option('--json', 'Output raw JSON')
    .action(async (options) => {
      await run(
        options.json,
        () => resolveAgent().listCapabilities(),
        renderCapabilities,
      );
    });
}
