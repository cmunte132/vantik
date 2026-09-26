import { Command } from 'commander';

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
  .description('Work Vantik issues, projects and pages from the terminal')
  .version(getVersion(), '-v, --version', 'Display the version number');

configureLoginCommand(program);
configureLogoutCommand(program);
configureTaskCommands(program);
configureProductAxisCommands(program);
configureProjectCommands(program);
configureKnowledgeCommands(program);
