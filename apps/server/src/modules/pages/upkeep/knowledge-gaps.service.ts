import { Injectable } from '@nestjs/common';
import { PageEntryCitationKind } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { LoggerService } from 'modules/logger/logger.service';

import { knowledgeSettings } from '../knowledge-settings';
import { moduleOfPath } from './findings';
import { ACCEPTED, markAnswered } from './gap-answers';
import KnowledgeIssues from './knowledge-issues';
import { redactSecrets } from '../triage/triage-policy';

/**
 * The most issues one run opens in a workspace, the most-asked gaps first.
 * The rest wait for the next run, so a workspace whose agents asked a
 * hundred unanswered questions gets ten issues a week, not a hundred at once.
 */
const MAX_ISSUES_PER_RUN = 10;

/** How much of a question an issue's title quotes. */
const MAX_TITLE_QUERY = 100;

/** Every gap issue's title starts with this. */
export const GAP_ISSUE_TITLE_PREFIX = 'Knowledge gap: ';

/**
 * How long a gap's lock may be held while its issue is opened, and how long
 * a second run waits for a connection.
 */
const OPEN_TIMEOUT_MS = 60_000;
const OPEN_MAX_WAIT_MS = 10_000;

/** A module, as a question names it. */
interface NamedModule {
  id: string;
  key: string;
  name: string;
}

/** A module's folders in one repository, as a question's path names them. */
interface ModuleFolders {
  moduleId: string;
  pathPrefixes: string[];
  fullName: string;
}

/** What one run of the job did. */
export interface GapIssuesRun {
  opened: number;
  answered: number;
}

/**
 * Turns the questions the knowledge keeps failing to answer into issues.
 *
 * A search that finds nothing records its question as a gap and counts how
 * often it is asked. On a schedule, each gap asked at least
 * `KNOWLEDGE_GAP_ISSUE_MIN_COUNT` times gets one issue asking a person to
 * answer it, on the team that owns the module the question names when it
 * names exactly one. The issue's id is stored on the gap, so a gap never gets
 * a second; and its title is fixed by the question and its body carries the
 * gap's id, so an issue opened by a run that failed before it could store the
 * id is found again rather than opened twice.
 *
 * The answer is an entry that cites the issue. Once one is accepted, the gap
 * is marked answered, by the entry: straight away, from wherever the entry was
 * accepted, and again by this job, which catches any that were missed.
 */
@Injectable()
export default class KnowledgeGapsService {
  private readonly logger = new LoggerService('KnowledgeGapsService');

  constructor(
    private prisma: PrismaService,
    private issues: KnowledgeIssues,
  ) {}

  /**
   * Marks answered the gaps whose issues have accepted answers, then opens
   * issues for the gaps asked often enough, in every workspace with an
   * unanswered gap. One workspace failing does not stop the others; the run
   * fails at the end, so it is recorded as failed and tried again, which
   * repeats nothing.
   */
  async openIssues(): Promise<GapIssuesRun> {
    const workspaces = await this.prisma.pageKnowledgeGap.findMany({
      where: { answeredAt: null },
      distinct: ['workspaceId'],
      select: { workspaceId: true },
    });
    const run: GapIssuesRun = { opened: 0, answered: 0 };
    const failed: string[] = [];

    for (const { workspaceId } of workspaces) {
      try {
        run.answered += await this.sweep(workspaceId);
        run.opened += await this.openFor(workspaceId);
      } catch (error) {
        failed.push(workspaceId);
        this.logger.error({
          message: `Could not open knowledge gap issues in workspace ${workspaceId}: ${error}`,
          where: 'KnowledgeGapsService.openIssues',
          error: error instanceof Error ? error : undefined,
        });
      }
    }

    if (failed.length) {
      throw new Error(
        `Knowledge gap issues failed in ${failed.length} workspace(s): ${failed.join(', ')}`,
      );
    }

    return run;
  }

  /** Marks answered the workspace's gaps whose issue an accepted entry cites. */
  private async sweep(workspaceId: string): Promise<number> {
    const waiting = await this.prisma.pageKnowledgeGap.findMany({
      where: { workspaceId, issueId: { not: null }, answeredAt: null },
      select: { issueId: true },
    });
    const issueIds = [
      ...new Set(
        waiting
          .map((gap) => gap.issueId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    if (!issueIds.length) {
      return 0;
    }

    const citations = await this.prisma.pageEntryCitation.findMany({
      where: {
        kind: PageEntryCitationKind.ISSUE,
        targetId: { in: issueIds },
        entry: {
          deleted: null,
          status: { in: ACCEPTED },
          page: { workspaceId, deleted: null },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { entryId: true, targetId: true },
    });

    return markAnswered(
      this.prisma,
      citations.map((citation) => ({
        workspaceId,
        issueId: citation.targetId as string,
        entryId: citation.entryId,
      })),
    );
  }

  /** Opens the workspace's due issues, and returns how many it opened. */
  private async openFor(workspaceId: string): Promise<number> {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, deleted: null },
      select: { preferences: true },
    });

    if (!workspace) {
      return 0;
    }

    const { gapIssueMinCount } = knowledgeSettings(workspace.preferences);
    const due = await this.prisma.pageKnowledgeGap.findMany({
      where: {
        workspaceId,
        issueId: null,
        answeredAt: null,
        count: { gte: gapIssueMinCount },
      },
      orderBy: [{ count: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
      take: MAX_ISSUES_PER_RUN,
      select: { id: true, query: true },
    });

    if (!due.length) {
      return 0;
    }

    const [modules, folders] = await Promise.all([
      this.prisma.module.findMany({
        where: { workspaceId, deleted: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true, key: true, name: true },
      }),
      this.prisma.moduleRepo.findMany({
        where: { deleted: null, module: { workspaceId, deleted: null } },
        orderBy: { createdAt: 'asc' },
        select: { moduleId: true, pathPrefixes: true, fullName: true },
      }),
    ]);
    let opened = 0;

    for (const gap of due) {
      if (
        await this.open(
          workspaceId,
          gap.id,
          moduleOfQuery(gap.query, modules, folders),
        )
      ) {
        opened++;
      }
    }

    return opened;
  }

  /**
   * Opens one gap's issue and stores it on the gap, under the gap's lock, so
   * a second run waiting on it finds the issue stored. True when an issue was
   * opened now; false when the gap has one already, or when the workspace has
   * no team to hold it, which the next run tries again.
   */
  private async open(
    workspaceId: string,
    gapId: string,
    moduleId: string | null,
  ): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`knowledge-gap:${gapId}`}, 0))`;

        const gap = await tx.pageKnowledgeGap.findFirst({
          where: { id: gapId, workspaceId, issueId: null, answeredAt: null },
          select: { id: true, query: true, count: true },
        });

        if (!gap) {
          return false;
        }

        const title = gapIssueTitle(gap.query);
        // Opened by a run that stopped before it could store it: the same
        // title, and the gap's id in the description.
        const found = await tx.issue.findFirst({
          where: {
            title,
            deleted: null,
            description: { contains: gap.id },
            team: { workspaceId, deleted: null },
          },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        const issue =
          found ??
          (await this.issues.open({
            workspaceId,
            moduleIds: moduleId ? [moduleId] : [],
            title,
            markdown: gapIssueMarkdown(gap),
          }));

        if (!issue) {
          return false;
        }

        await tx.pageKnowledgeGap.update({
          where: { id: gap.id },
          data: { issueId: issue.id, moduleId },
        });

        return !found;
      },
      { timeout: OPEN_TIMEOUT_MS, maxWait: OPEN_MAX_WAIT_MS },
    );
  }
}

/**
 * A gap issue's title: fixed by the question alone, so every run gives the
 * same one. Secrets are withheld, and a long question is cut.
 */
export function gapIssueTitle(query: string): string {
  const question = redactSecrets(query).replace(/\s+/g, ' ').trim();

  return `${GAP_ISSUE_TITLE_PREFIX}${
    question.length > MAX_TITLE_QUERY
      ? `${question.slice(0, MAX_TITLE_QUERY - 3)}...`
      : question
  }`;
}

/** What a gap issue asks, and how to answer it so the gap closes. */
function gapIssueMarkdown(gap: {
  id: string;
  query: string;
  count: number;
}): string {
  return [
    `Agents searched the workspace's knowledge for this ${gap.count} times, ` +
      'and it had nothing to give them:',
    '',
    `> ${redactSecrets(gap.query).replace(/\s+/g, ' ').trim()}`,
    '',
    'Answer it by writing an entry on a page that cites this issue. Once the ' +
      'entry is accepted, the question counts as answered, and agents asking ' +
      'it find the entry.',
    '',
    `Knowledge gap \`${gap.id}\`.`,
  ].join('\n');
}

/**
 * The module a question is about, when it names exactly one. A question names
 * a module by a path in it, which belongs to the deepest module holding it,
 * as a finding's file does; or by the module's name or short name, written as
 * words in it. A question naming none, or several, is about no one module,
 * and its issue goes to the workspace's default team.
 */
export function moduleOfQuery(
  query: string,
  modules: NamedModule[],
  folders: ModuleFolders[],
): string | null {
  const named = new Set<string>();
  const words: string[] = [];

  for (const token of query.toLowerCase().split(/\s+/)) {
    const path = token
      .replace(/^[^a-z0-9_.-]+|[^a-z0-9_.-]+$/g, '')
      .replace(/^\.\//, '');

    // A path is read as a path only: its folders are not names, or
    // `apps/api/src/cache` would name both the API and the cache.
    if (!path.includes('/')) {
      words.push(token);
      continue;
    }

    const holder = moduleOfFile(folders, path);

    if (holder) {
      named.add(holder);
    }
  }

  const text = ` ${words
    .join(' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;

  for (const candidate of modules) {
    for (const label of [candidate.name, candidate.key]) {
      const phrase = (label ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

      if (phrase && text.includes(` ${phrase} `)) {
        named.add(candidate.id);
      }
    }
  }

  return named.size === 1 ? [...named][0] : null;
}

/**
 * The deepest module holding a path a question gives. A path that starts with
 * a repository's full name is read in that repository. Any other is read in
 * every repository, and a module that is a whole repository holds it only
 * when the workspace has that one repository, so a path in a workspace with
 * two is not read as belonging to either whole.
 */
function moduleOfFile(folders: ModuleFolders[], path: string): string | null {
  const repositories = [
    ...new Set(folders.map((folder) => folder.fullName.toLowerCase())),
  ];
  const repository = repositories
    .filter((name) => path.startsWith(`${name}/`))
    .sort((a, b) => b.length - a.length)[0];
  const inRepository = repository ? path.slice(repository.length + 1) : path;
  // Questions are stored lower-cased, so folders are compared lower-cased.
  const readable = folders
    .filter((folder) =>
      repository
        ? folder.fullName.toLowerCase() === repository
        : folder.pathPrefixes.length > 0 || repositories.length === 1,
    )
    .map((folder) => ({
      moduleId: folder.moduleId,
      pathPrefixes: folder.pathPrefixes.map((prefix) => prefix.toLowerCase()),
    }));

  // Read as a folder, so `apps/server` is held by `apps/server/`, as a file
  // in it is.
  return inRepository ? moduleOfPath(readable, `${inRepository}/`) : null;
}
