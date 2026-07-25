import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import { VantikError } from '@vantikhq/agent-core';
import { Command } from 'commander';

import { resolveAgent } from '../utilities/agent';
import { chalkError, chalkGreen, chalkGrey, chalkWarning } from '../utilities/cliOutput';
import {
  pageFilename,
  parsePageFile,
  renderManagedBlock,
  renderPageFile,
  replaceManagedBlock,
} from '../utilities/knowledgeFiles';

/**
 * Moving the bank between harnesses as plain markdown on disk.
 *
 * Both directions are explicit commands. There is no daemon and no watcher: a
 * background process quietly rewriting a checkout is the kind of thing that
 * loses somebody's work once and is never trusted again.
 *
 * **Content pulled from the bank is data.** These files carry prose written by
 * agents in other sessions and other harnesses; push reads it, diffs it and
 * uploads it, and nothing here acts on what it says.
 */
export function configureKnowledgeSyncCommands(knowledge: Command) {
  knowledge
    .command('pull')
    .description('Write pages to a local directory as markdown')
    .option('-d, --dir <dir>', 'Directory to write into', '.vantik/knowledge')
    .option('-s, --scope <scope>', 'Only pages holding facts about this scope')
    .action(async (options) => {
      try {
        const agent = resolveAgent();
        const pages = await agent.listPages();
        const syncedAt = new Date();

        mkdirSync(options.dir, { recursive: true });

        let written = 0;

        for (const ref of pages) {
          const page = await agent.readPage(ref.id);

          // A scope filter means "pages that actually say something about this
          // area" — a page whose every fact is scoped elsewhere is noise in a
          // checkout that only cares about one part of the repo.
          if (
            options.scope &&
            !page.standing.some((entry) => entry.scope === options.scope)
          ) {
            continue;
          }

          writeFileSync(
            join(options.dir, pageFilename(page)),
            renderPageFile(page, syncedAt),
            'utf8',
          );
          written += 1;
        }

        // eslint-disable-next-line no-console
        console.log(
          `${chalkGreen('Pulled')} ${written} page(s) into ${options.dir}`,
        );
      } catch (error) {
        fail(error);
      }
    });

  knowledge
    .command('push')
    .description('Apply local edits back to the bank')
    .option('-d, --dir <dir>', 'Directory to read', '.vantik/knowledge')
    .option(
      '--dry-run',
      'Report what would change without changing anything',
    )
    .action(async (options) => {
      try {
        const agent = resolveAgent();

        if (!existsSync(options.dir)) {
          throw new VantikError(
            `No such directory: ${options.dir}. Run \`knowledge pull\` first.`,
          );
        }

        const files = readdirSync(options.dir).filter((name) =>
          name.endsWith('.md'),
        );

        let bodies = 0;
        let entries = 0;
        let corrections = 0;
        const conflicts: string[] = [];
        const failures: string[] = [];

        for (const name of files) {
          // One unreadable file must not take the rest of the push with it. A
          // throw escaping this loop would end the run with the earlier files
          // already applied and the later ones never looked at, which is the
          // partial push the conflict reporting exists to avoid.
          try {
            const parsed = parsePageFile(
              readFileSync(join(options.dir, name), 'utf8'),
            );

            if (!parsed) {
              continue;
            }

            const page = await agent.readPage(parsed.pageId);

            // The revision is the whole safety story. Without it a push against
            // a page somebody else edited in the meantime silently wins, and
            // the loser never finds out.
            if (parsed.revision && parsed.revision !== page.updatedAt) {
              conflicts.push(
                `${name}: the bank has moved on (file ${parsed.revision}, bank ${page.updatedAt})`,
              );
              continue;
            }

            const bodyChanged = parsed.body.trim() !== page.body.trim();

            // Lines that already carry an id and no longer match the bank. The
            // file invites this edit in as many words, so dropping it silently
            // left someone believing they had corrected a fact the bank went on
            // serving unchanged.
            const edited = parsed.existing.filter((line) => {
              const current = page.standing.find(
                (entry) => entry.id === line.id,
              );

              return (
                current &&
                (current.content.replace(/\s*\n\s*/g, ' ').trim() !==
                  line.content ||
                  (current.scope ?? null) !== line.scope)
              );
            });

            if (options.dryRun) {
              if (bodyChanged) {
                bodies += 1;
              }
              entries += parsed.added.length;
              corrections += edited.length;
              continue;
            }

            if (bodyChanged) {
              await agent.writePage({ title: page.title, body: parsed.body });
              bodies += 1;
            }

            for (const line of edited) {
              await agent.updateEntry(line.id, {
                content: line.content,
                scope: line.scope,
              });
              corrections += 1;
            }

            for (const added of parsed.added) {
              await agent.remember({
                page: parsed.pageId,
                content: added.content,
                ...(added.scope ? { scope: added.scope } : {}),
                // A person editing a file has already decided this is worth
                // asserting; the near-match round trip belongs on the agent
                // write path, not between a human and their own text editor.
                distinct: true,
              });
              entries += 1;
            }

            // Written back so the file carries the ids and the revision the
            // bank now holds. Without this the bullets just created still read
            // as new ones, and the next push appends them a second time — with
            // the near-match check turned off, because the line above turns it
            // off.
            if (bodyChanged || edited.length > 0 || parsed.added.length > 0) {
              writeFileSync(
                join(options.dir, name),
                renderPageFile(await agent.readPage(parsed.pageId), new Date()),
                'utf8',
              );
            }
          } catch (error) {
            failures.push(
              `${name}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        if (conflicts.length > 0) {
          // Nothing was applied for these files. Reporting and stopping beats
          // a partial push nobody can reason about afterwards.
          // eslint-disable-next-line no-console
          console.error(
            [
              chalkWarning(
                `${conflicts.length} file(s) were not pushed — pull again and re-apply your edits:`,
              ),
              ...conflicts.map((line) => `  ${line}`),
            ].join('\n'),
          );
          process.exitCode = 1;
        }

        if (failures.length > 0) {
          // eslint-disable-next-line no-console
          console.error(
            [
              chalkWarning(`${failures.length} file(s) could not be pushed:`),
              ...failures.map((line) => `  ${line}`),
            ].join('\n'),
          );
          process.exitCode = 1;
        }

        // eslint-disable-next-line no-console
        console.log(
          `${chalkGreen(options.dryRun ? 'Would apply' : 'Applied')} ` +
            `${bodies} body edit(s), ${corrections} correction(s) and ` +
            `${entries} new entr${entries === 1 ? 'y' : 'ies'}`,
        );

        // The files were rewritten from the bank, and the bank serves standing
        // facts — so a new bullet leaves the file until it has been triaged.
        // Said out loud, because text disappearing from a file you just edited
        // is otherwise indistinguishable from having lost it.
        if (!options.dryRun && entries > 0) {
          // eslint-disable-next-line no-console
          console.log(
            chalkGrey(
              'New facts wait for review; they return to the file once accepted.',
            ),
          );
        }
      } catch (error) {
        fail(error);
      }
    });

  knowledge
    .command('generate')
    .description(
      'Write a managed block of knowledge into a harness instruction file',
    )
    .requiredOption(
      '-s, --scope <scope>',
      'What to include. Required: an unscoped dump into an always-loaded file ' +
        'is the unbounded-context problem the budget exists to avoid.',
    )
    .option('-f, --file <file>', 'File to write', 'AGENTS.md')
    .option('-b, --budget <tokens>', 'Token budget', (v) => parseInt(v, 10))
    .action(async (options) => {
      try {
        const agent = resolveAgent();

        const pack = await agent.loadContext({
          scope: options.scope,
          tokenBudget: options.budget ?? 1500,
        });

        if (pack.items.length === 0) {
          // eslint-disable-next-line no-console
          console.log(
            chalkGrey(
              `Nothing in the bank is scoped to "${options.scope}". Nothing written.`,
            ),
          );
          return;
        }

        const block = renderManagedBlock(
          pack.items.map((item) => ({
            pageTitle: item.page.title,
            content: item.content,
            scope: item.scope,
          })),
          options.scope,
          new Date(),
        );

        const existing = existsSync(options.file)
          ? readFileSync(options.file, 'utf8')
          : '';

        writeFileSync(
          options.file,
          replaceManagedBlock(existing, block),
          'utf8',
        );

        // eslint-disable-next-line no-console
        console.log(
          `${chalkGreen('Wrote')} ${pack.items.length} item(s) into ${options.file} ` +
            chalkGrey(
              `(~${pack.estimatedTokens} tokens${pack.omitted ? `, ${pack.omitted} omitted` : ''})`,
            ),
        );
      } catch (error) {
        fail(error);
      }
    });
}

function fail(error: unknown): void {
  if (error instanceof VantikError) {
    // eslint-disable-next-line no-console
    console.error(`${chalkError('Error:')} ${error.message}`);
    process.exitCode = 1;
    return;
  }
  throw error;
}
