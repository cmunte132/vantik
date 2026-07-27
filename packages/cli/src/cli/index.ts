import { Command } from 'commander';

import { configureAgentCommands } from '../commands/agent';
import { configureDeployCommand } from '../commands/deploy';
import { configureInitCommand } from '../commands/init';
import { configureKnowledgeCommands } from '../commands/knowledge';
import { configureLoginCommand } from '../commands/login';
import { configureLogoutCommand } from '../commands/logout';
import { configureProductAxisCommands } from '../commands/product-axis';
import { configureProjectCommands } from '../commands/project';
import { configureTaskCommands } from '../commands/task';
import { COMMAND_NAME } from '../consts';
import { getVersion } from '../utilities/getVersion';

export const program = new Command();

program
  .name(COMMAND_NAME)
  .description('Cli to run vantik actions')
  .version(getVersion(), '-v, --version', 'Display the version number');

configureDeployCommand(program);
configureInitCommand(program);
configureLoginCommand(program);
configureLogoutCommand(program);
configureTaskCommands(program);
configureProductAxisCommands(program);
configureProjectCommands(program);
configureAgentCommands(program);
configureKnowledgeCommands(program);
