import { VantikError } from '@vantikhq/agent-core';
import { Command } from 'commander';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveAgent, resolveClient } from '../utilities/agent';
import { chalkError, chalkGreen, chalkGrey } from '../utilities/cliOutput';
import { RunnerClient } from '../runner/client';
import { runDaemon } from '../runner/daemon';
import { PI_PACKAGE } from '../runner/pi-harness';

/**
 * The runner: the executor that needs no Vantik-side infrastructure.
 *
 * It holds the user's model credentials and repo access; the server never sees
 * either, and rejects any attempt to send them. That property is the whole
 * reason this exists alongside a hosted sandbox.
 */
export function configureAgentCommands(program: Command) {
  const agent = program
    .command('agent')
    .description('Run agent work on this machine');

  agent
    .command('work')
    .description('Claim delegated issues and work them with a coding harness')
    .option('--repo <path>', 'Repository to work in', process.cwd())
    .option('-b, --base <branch>', 'Base branch to work from')
    .option('--executor <key>', 'Only take work for this executor', 'byo')
    .option(
      '--harness <command>',
      `Harness command; defaults to the bundled ${PI_PACKAGE}`,
    )
    .option('--model <id>', 'Model the bundled harness asks for')
    .option(
      '--provider <name>',
      'Provider to route the model through, when the id alone is ambiguous',
    )
    .option(
      '--worktree-root <path>',
      'Where finished worktrees are created; defaults beside the repo',
    )
    .option(
      '-n, --poll <seconds>',
      'Seconds between polls when nothing is queued',
      (value) => Number.parseInt(value, 10),
      10,
    )
    .option(
      '-t, --timeout <minutes>',
      'Give up on a single run after this long',
      (value) => Number.parseInt(value, 10),
      30,
    )
    .option('--once', 'Take one run and exit')
    .option(
      '--dry-run',
      'Leave the diff on disk; never push and never open a pull request',
    )
    .option('--log-dir <path>', 'Where per-run logs are written')
    .action(async (options) => {
      try {
        const client = new RunnerClient(resolveClient());

        await runDaemon({
          client,
          executor: options.executor,
          repoPath: options.repo,
          baseBranch: options.base,
          worktreeRoot: options.worktreeRoot,
          pollSeconds: options.poll,
          timeoutMs: options.timeout * 60 * 1000,
          dryRun: options.dryRun,
          harnessCommand: options.harness,
          model: options.model,
          provider: options.provider,
          once: options.once,
          logDir:
            options.logDir ?? join(homedir(), '.vantik', 'runs'),
          // eslint-disable-next-line no-console
          log: (line) => console.log(line),
        });
      } catch (error) {
        if (error instanceof VantikError) {
          // eslint-disable-next-line no-console
          console.error(`${chalkError('Error:')} ${error.message}`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }
    });

  agent
    .command('runs')
    .description('Agent runs across the workspace, newest first')
    .option('-n, --limit <n>', 'Rows', (value) => Number.parseInt(value, 10), 20)
    .option('--json', 'Output raw JSON')
    .action(async (options) => {
      try {
        const page = await resolveAgent().listWorkspaceAgentRuns({
          perPage: options.limit,
        });

        if (options.json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify(page, null, 2));
          return;
        }

        if (page.items.length === 0) {
          // eslint-disable-next-line no-console
          console.log(chalkGrey('No agent runs yet.'));
          return;
        }

        for (const run of page.items) {
          const where = run.prUrl ?? run.worktreePath ?? run.branch ?? '';
          // eslint-disable-next-line no-console
          console.log(
            `${chalkGreen(run.status.padEnd(12))} ${chalkGrey(
              `attempt ${run.attempt}`,
            )}  ${run.failure ?? where}`,
          );
        }
      } catch (error) {
        if (error instanceof VantikError) {
          // eslint-disable-next-line no-console
          console.error(`${chalkError('Error:')} ${error.message}`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }
    });

  return agent;
}
