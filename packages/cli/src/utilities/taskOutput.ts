import type {
  Capability,
  Module,
  Paginated,
  Product,
  TaskContext,
  TaskListItem,
  TaskNote,
  TaskRef,
  TaskSearchHit,
} from '@vantikhq/agent-core';

import Table from 'cli-table3';

import { chalkGreen, chalkGrey } from './cliOutput';

/**
 * Human-readable renderers for the task commands. Every command also takes
 * `--json`, which bypasses these and prints the raw agent-core value; these are
 * only the friendly default. They format, they do not decide — no opinion about
 * the work lives here, only about columns and spacing.
 */

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function renderList(page: Paginated<TaskListItem>): string {
  if (page.items.length === 0) {
    return chalkGrey('No matching tasks.');
  }

  const table = new Table({
    head: ['Key', 'Pri', 'State', 'Title', 'Updated'],
    style: { head: [], border: [] },
  });

  for (const item of page.items) {
    table.push([
      chalkGreen(item.key),
      item.priority,
      item.state,
      truncate(item.title, 60),
      new Date(item.updatedAt).toISOString().slice(0, 10),
    ]);
  }

  const shown = page.items.length;
  const footer = chalkGrey(
    `${shown} of ${page.total} (page ${page.page}, ${page.perPage}/page)`,
  );
  return `${table.toString()}\n${footer}`;
}

export function renderTask(task: TaskContext): string {
  const lines: string[] = [];
  lines.push(`${chalkGreen(task.key)}  ${task.title}`);

  const meta = [
    `state: ${task.state.name} (${task.state.category})`,
    `priority: ${task.priority}`,
    `assignee: ${task.assignee?.fullname ?? '—'}`,
    `team: ${task.team.identifier}`,
  ];
  if (task.labels.length) {
    meta.push(`labels: ${task.labels.map((label) => label.name).join(', ')}`);
  }
  if (task.parent) {
    meta.push(`parent: ${task.parent.key}`);
  }
  if (task.modules.length) {
    meta.push(
      `modules: ${task.modules.map((module) => module.name).join(', ')}`,
    );
  }
  if (task.capability) {
    meta.push(`capability: ${task.capability.name}`);
  }
  lines.push(chalkGrey(meta.join('  |  ')));

  if (task.description.trim()) {
    lines.push('', task.description.trim());
  }

  if (task.subTasks.length) {
    lines.push('', chalkGrey('Sub-tasks:'));
    for (const sub of task.subTasks) {
      lines.push(`  ${chalkGreen(sub.key)} ${truncate(sub.title, 60)}`);
    }
  }

  if (task.relations.length) {
    lines.push('', chalkGrey('Relations:'));
    for (const rel of task.relations) {
      lines.push(`  ${rel.type} ${chalkGreen(rel.task.key)}`);
    }
  }

  if (task.notes.length) {
    lines.push('', chalkGrey(`Notes (${task.notes.length}):`));
    for (const note of task.notes) {
      lines.push(renderNoteLine(note));
    }
  }

  return lines.join('\n');
}

function renderNoteLine(note: TaskNote): string {
  const who = note.author ?? 'unknown';
  const when = new Date(note.createdAt).toISOString().slice(0, 10);
  return `  ${chalkGrey(`${who}, ${when}:`)} ${truncate(note.body, 100)}`;
}

export function renderHits(hits: TaskSearchHit[]): string {
  if (hits.length === 0) {
    return chalkGrey('No matches.');
  }

  return hits
    .map((hit) => {
      const head = `${chalkGreen(hit.key)}  ${truncate(hit.title, 70)}${
        hit.stateCategory ? chalkGrey(`  [${hit.stateCategory}]`) : ''
      }`;
      const resolution = hit.resolution
        ? `\n  ${chalkGrey('resolved:')} ${truncate(hit.resolution, 100)}`
        : '';
      return `${head}${resolution}`;
    })
    .join('\n');
}

export function renderNote(note: TaskNote): string {
  return `${chalkGreen('✓')} Note added${note.author ? ` as ${note.author}` : ''}.`;
}

export function renderRef(ref: TaskRef, verb: string): string {
  return `${chalkGreen('✓')} ${verb} ${chalkGreen(ref.key)}  ${ref.title}`;
}

export function renderProducts(products: Product[]): string {
  if (products.length === 0) {
    return chalkGrey('No products yet.');
  }

  const table = new Table({
    head: ['Key', 'Name', 'Status', 'Description'],
    style: { head: [], border: [] },
  });

  for (const product of products) {
    table.push([
      chalkGreen(product.key),
      product.name,
      product.status ?? '—',
      truncate(product.description ?? '', 50),
    ]);
  }

  return table.toString();
}

/**
 * Modules with the repositories they sit in, because "which module is this
 * checkout?" is the question this listing is usually answering.
 */
export function renderModules(modules: Module[]): string {
  if (modules.length === 0) {
    return chalkGrey('No modules yet.');
  }

  const table = new Table({
    head: ['Key', 'Name', 'Owner', 'Repositories'],
    style: { head: [], border: [] },
  });

  for (const module of modules) {
    table.push([
      chalkGreen(module.key),
      module.name,
      module.owner ? module.owner.kind : '—',
      truncate(
        (module.repos ?? [])
          .map((repo) =>
            repo.pathPrefixes.length
              ? `${repo.repository}:${repo.pathPrefixes.join(',')}`
              : repo.repository,
          )
          .join(' ') || '—',
        50,
      ),
    ]);
  }

  return table.toString();
}

export function renderCapabilities(capabilities: Capability[]): string {
  if (capabilities.length === 0) {
    return chalkGrey('No capabilities yet.');
  }

  const table = new Table({
    head: ['Name', 'Status', 'Modules', 'Description'],
    style: { head: [], border: [] },
  });

  for (const capability of capabilities) {
    table.push([
      chalkGreen(capability.name),
      capability.status ?? '—',
      String(capability.moduleIds.length),
      truncate(capability.description ?? '', 50),
    ]);
  }

  return table.toString();
}
