import { Command } from 'commander';

import { resolveAgent } from '../utilities/agent';
import { chalkError, chalkGreen, chalkGrey } from '../utilities/cliOutput';
import { resolveBody } from '../utilities/stdin';
import {
  renderCapabilities,
  renderModules,
  renderProducts,
} from '../utilities/taskOutput';

/**
 * The product axis from the terminal.
 *
 * A team says who works on something; this axis says what the software is made
 * of and what it does. The plural commands answer the two questions a person
 * has before filing or picking up work: which module am I in, and does a
 * capability for this already exist. The singular groups write the axis, as
 * the app does, and stay neutral like the rest of the CLI: the server's rules
 * come back as the server words them.
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

/** One line for a row that was just written. */
function written(verb: string) {
  return (row: { id: string; name?: string; repository?: string }) =>
    `${chalkGreen('✓')} ${verb} ${chalkGreen(
      row.name ?? row.repository ?? row.id,
    )}  ${chalkGrey(row.id)}`;
}

const DESCRIPTION_HELP = 'Description (markdown); "-" reads it from stdin';

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
        () =>
          resolveAgent().listModules({ withRepos: options.repos !== false }),
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

  configureProductCommands(program);
  configureModuleCommands(program);
  configureCapabilityCommands(program);
}

function configureProductCommands(program: Command) {
  const product = program
    .command('product')
    .description('Create and change products');

  product
    .command('create')
    .description('Add a product')
    .argument('<name...>', 'Product name')
    .option('--key <key>', 'Short name; made from the name if omitted')
    .option('-d, --description <markdown>', DESCRIPTION_HELP)
    .option('-s, --status <status>', 'Status')
    .option('--json', 'Output raw JSON')
    .action(async (name, options) => {
      const description = await resolveBody(options.description);
      await run(
        options.json,
        () =>
          resolveAgent().createProduct({
            name: name.join(' '),
            key: options.key,
            description,
            status: options.status,
          }),
        written('Created'),
      );
    });

  product
    .command('update')
    .description('Change a product')
    .argument('<product>', 'Product key, name or id')
    .option('--name <name>', 'New name')
    .option('--key <key>', 'New short name')
    .option('-d, --description <markdown>', `New ${DESCRIPTION_HELP}`)
    .option('-s, --status <status>', 'Status')
    .option('--json', 'Output raw JSON')
    .action(async (ref, options) => {
      const description = await resolveBody(options.description);
      await run(
        options.json,
        () =>
          resolveAgent().updateProduct(ref, {
            name: options.name,
            key: options.key,
            description,
            status: options.status,
          }),
        written('Updated'),
      );
    });
}

/** The options `module create` and `module update` share. */
function moduleOptions(command: Command, onUpdate: boolean): Command {
  const replaces = onUpdate ? '; replaces the set' : '';
  return command
    .option('--key <key>', 'Short name; made from the name if omitted')
    .option('-d, --description <markdown>', DESCRIPTION_HELP)
    .option('-s, --status <status>', 'Status')
    .option(
      '--owner-team <team>',
      'Owning team, by identifier, name or id. Give this or --owner-product',
    )
    .option('--owner-product <product>', 'Owning product, by key, name or id')
    .option('--linked-team <team...>', `Other teams that use it${replaces}`)
    .option(
      '--linked-product <product...>',
      `Other products that use it${replaces}`,
    )
    .option('--json', 'Output raw JSON');
}

function moduleInput(options: {
  key?: string;
  status?: string;
  ownerTeam?: string;
  ownerProduct?: string;
  linkedTeam?: string[];
  linkedProduct?: string[];
}) {
  return {
    key: options.key,
    status: options.status,
    ownerTeam: options.ownerTeam,
    ownerProduct: options.ownerProduct,
    linkedTeams: options.linkedTeam,
    linkedProducts: options.linkedProduct,
  };
}

/** The options `module add-repo` and `module update-repo` share. */
function repoOptions(command: Command): Command {
  return command
    .argument('<module>', 'Module key, name or id')
    .argument(
      '<repository>',
      'The repository as its source names it, owner/name',
    )
    .option(
      '--path <prefix...>',
      'Paths in the repository that belong to the module; none means all of it',
    )
    .option('--default', 'Make this the repository an agent run works in')
    .option('--json', 'Output raw JSON');
}

function configureModuleCommands(program: Command) {
  const module = program
    .command('module')
    .description('Create and change modules, and link their repositories');

  moduleOptions(
    module
      .command('create')
      .description('Add a module')
      .argument('<name...>', 'Module name'),
    false,
  ).action(async (name, options) => {
    const description = await resolveBody(options.description);
    await run(
      options.json,
      () =>
        resolveAgent().createModule({
          name: name.join(' '),
          description,
          ...moduleInput(options),
        }),
      written('Created'),
    );
  });

  moduleOptions(
    module
      .command('update')
      .description('Change a module')
      .argument('<module>', 'Module key, name or id')
      .option('--name <name>', 'New name'),
    true,
  ).action(async (ref, options) => {
    const description = await resolveBody(options.description);
    await run(
      options.json,
      () =>
        resolveAgent().updateModule(ref, {
          name: options.name,
          description,
          ...moduleInput(options),
        }),
      written('Updated'),
    );
  });

  module
    .command('available-repos')
    .description('The repositories that connected sources offer to modules')
    .option('--json', 'Output raw JSON')
    .action(async (options) => {
      await run(
        options.json,
        () => resolveAgent().listAvailableRepos(),
        (repos) =>
          repos.length === 0
            ? chalkGrey(
                'No connected source offers a repository. Connect one in ' +
                  'Settings > Integrations.',
              )
            : repos
                .map((repo) => `${repo.repository}  ${chalkGrey(repo.source)}`)
                .join('\n'),
      );
    });

  repoOptions(
    module
      .command('add-repo')
      .description('Link a repository, or paths in one, to a module'),
  ).action(async (ref, repository, options) => {
    await run(
      options.json,
      () =>
        resolveAgent().addModuleRepo(ref, {
          repository,
          pathPrefixes: options.path,
          isDefault: options.default,
        }),
      written('Linked'),
    );
  });

  repoOptions(
    module
      .command('update-repo')
      .description('Change the paths of a repository linked to a module'),
  ).action(async (ref, repository, options) => {
    await run(
      options.json,
      () =>
        resolveAgent().updateModuleRepo(ref, {
          repository,
          pathPrefixes: options.path,
          isDefault: options.default,
        }),
      written('Updated'),
    );
  });
}

function configureCapabilityCommands(program: Command) {
  const capability = program
    .command('capability')
    .description('Create and change capabilities');

  capability
    .command('create')
    .description('Add a capability')
    .argument('<name...>', 'Capability name')
    .option('-d, --description <markdown>', DESCRIPTION_HELP)
    .option(
      '-s, --status <status>',
      'planned, active, live or deprecated; defaults to planned',
    )
    .option('--module <module...>', 'Modules that hold the code')
    .option('--json', 'Output raw JSON')
    .action(async (name, options) => {
      const description = await resolveBody(options.description);
      await run(
        options.json,
        () =>
          resolveAgent().createCapability({
            name: name.join(' '),
            description,
            status: options.status,
            modules: options.module,
          }),
        written('Created'),
      );
    });

  capability
    .command('update')
    .description('Change a capability')
    .argument('<capability>', 'Capability name or id')
    .option('--name <name>', 'New name')
    .option('-d, --description <markdown>', `New ${DESCRIPTION_HELP}`)
    .option('-s, --status <status>', 'planned, active, live or deprecated')
    .option(
      '--module <module...>',
      'Modules that hold the code; replaces the set',
    )
    .option('--json', 'Output raw JSON')
    .action(async (ref, options) => {
      const description = await resolveBody(options.description);
      await run(
        options.json,
        () =>
          resolveAgent().updateCapability(ref, {
            name: options.name,
            description,
            status: options.status,
            modules: options.module,
          }),
        written('Updated'),
      );
    });
}
