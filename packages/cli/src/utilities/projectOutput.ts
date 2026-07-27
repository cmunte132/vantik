import type { Project } from '@vantikhq/agent-core';

import Table from 'cli-table3';

import { chalkGreen, chalkGrey } from './cliOutput';

/**
 * Human-readable renderers for the project commands, alongside `taskOutput`.
 * Every command also takes `--json`, which bypasses these; these are only the
 * friendly default, and they format rather than decide.
 */

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function renderProjectList(projects: Project[]): string {
  if (projects.length === 0) {
    return chalkGrey('No projects yet.');
  }

  const table = new Table({
    head: ['Name', 'Status', 'Description'],
    style: { head: [], border: [] },
  });

  for (const project of projects) {
    table.push([
      chalkGreen(project.name),
      project.status ?? '—',
      project.description ? truncate(project.description, 60) : chalkGrey('—'),
    ]);
  }

  return `${table.toString()}\n${chalkGrey(
    `${projects.length} project${projects.length === 1 ? '' : 's'}`,
  )}`;
}

export function renderProject(project: Project): string {
  const lines = [
    `${chalkGreen(project.name)}  ${chalkGrey(project.id)}`,
    `${chalkGrey('status:')} ${project.status ?? '—'}`,
  ];

  // Printed raw, not truncated: the description is the whole reason to look a
  // project up, and it is markdown the caller may well be piping onward.
  if (project.description) {
    lines.push('', project.description);
  }

  return lines.join('\n');
}

export function renderProjectRef(project: Project, verb: string): string {
  return `${chalkGreen('✓')} ${verb} ${chalkGreen(project.name)}  ${chalkGrey(
    project.id,
  )}`;
}
