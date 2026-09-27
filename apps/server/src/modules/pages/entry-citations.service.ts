import { InjectQueue } from '@nestjs/bull';
import {
  Injectable,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PageEntryCitationCheckEnum,
  PageEntryCitationInputDto,
  PageEntryCitationJudgmentEnum,
  PageEntryCitationKindEnum,
} from '@vantikhq/types';
import { Queue } from 'bull';
import {
  cleanRepoPath,
  COMMIT_SHA,
  type RepoFileRead,
} from 'integrations/repo-files';
import { PrismaService } from 'nestjs-prisma';

import { pathBelongsToModule } from 'modules/modules/module-routing';

import CitationJudge from './citation-judge';
import {
  formatLineRange,
  fileLines,
  parseLineRange,
  relocate,
  snippetAt,
  snippetContains,
  type LineRange,
} from './citation-matching';
import KnowledgeIndexService from './knowledge-index.service';
import {
  PAGES_QUEUE,
  RETRY_CITATIONS_JOB,
  retryCitationsJobOptions,
} from './pages.interface';
import RepoFileSourceService, {
  type CitedRepo,
} from './repo-file-source.service';

/** A citation ready to be created with its entry. */
export interface CitationDraft {
  kind: PageEntryCitationKindEnum;
  moduleRepoId?: string;
  path?: string;
  commitSha?: string | null;
  startLine?: number;
  endLine?: number;
  snippet?: string | null;
  snippetHash?: string | null;
  targetId?: string;
  targetLabel?: string;
  checkedAt: Date | null;
  checkedSha?: string | null;
  checkResult: PageEntryCitationCheckEnum;
}

/** Lines of context either side of a changed citation, shown to the judge. */
const JUDGE_CONTEXT_LINES = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ISSUE_KEY = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;

interface CitationRow {
  id: string;
  kind: string;
  moduleRepoId: string | null;
  path: string | null;
  commitSha: string | null;
  startLine: number | null;
  endLine: number | null;
  snippet: string | null;
  targetId: string | null;
  checkResult: string | null;
}

/**
 * Checks what an entry's claim rests on.
 *
 * On a write, every citation is checked before anything is stored, and one
 * that does not hold refuses the write with its position and the reason, so
 * the writer can correct it. The server reads cited code itself and keeps
 * what it read; a snippet the writer supplies is never trusted, only compared.
 *
 * Afterwards, a check compares the cited snippet with the default branch as it
 * is now. That comparison is text, and decides held, moved, changed or
 * missing. Only changed goes to a judge model, and only for its opinion,
 * recorded beside the result.
 */
@Injectable()
export default class EntryCitationsService {
  constructor(
    private prisma: PrismaService,
    private files: RepoFileSourceService,
    private judge: CitationJudge,
    // A check that changes a result can change the entry's trust, which the
    // index ranks by.
    @Optional() private indexer?: KnowledgeIndexService,
    @Optional() @InjectQueue(PAGES_QUEUE) private pagesQueue?: Queue,
  ) {}

  // ------------------------------------------------------------------ write

  /**
   * The citations for a write, checked, or a refusal naming the first that
   * does not hold.
   *
   * A repository that cannot be reached gives an UNKNOWN citation and the
   * write goes ahead: the server's failure to read the code is not evidence
   * against the claim. The citation is retried later.
   */
  async checkForWrite(
    workspaceId: string,
    inputs: PageEntryCitationInputDto[],
  ): Promise<CitationDraft[]> {
    const drafts: CitationDraft[] = [];

    for (const [index, input] of inputs.entries()) {
      drafts.push(await this.checkOne(workspaceId, input, index));
    }

    return drafts;
  }

  /** Queues the retry of an entry's UNKNOWN citations, when it has any. */
  async retryLater(entryId: string, drafts: CitationDraft[]): Promise<void> {
    if (
      !drafts.some(
        (draft) => draft.checkResult === PageEntryCitationCheckEnum.UNKNOWN,
      )
    ) {
      return;
    }

    try {
      await this.pagesQueue?.add(
        RETRY_CITATIONS_JOB,
        { entryId },
        retryCitationsJobOptions(entryId),
      );
    } catch {
      // The citation stays UNKNOWN, which never counts against the entry; a
      // later check reads it again.
    }
  }

  private async checkOne(
    workspaceId: string,
    input: PageEntryCitationInputDto,
    index: number,
  ): Promise<CitationDraft> {
    const targets = [
      input.path !== undefined && 'path',
      input.issue !== undefined && 'issue',
      input.pullRequest !== undefined && 'pullRequest',
      input.comment !== undefined && 'comment',
      input.run !== undefined && 'run',
    ].filter(Boolean);

    if (targets.length !== 1) {
      throw refusal(
        index,
        targets.length === 0
          ? 'names nothing to cite. Give a path with lines, or an issue, pullRequest, comment or run'
          : `names ${targets.join(' and ')}. One citation cites one thing; give each its own citation`,
      );
    }

    if (input.path !== undefined) {
      return this.checkCode(workspaceId, input, index);
    }

    const target = await this.findTarget(workspaceId, input);

    if (!target) {
      throw refusal(index, `${describeTarget(input)} is not in this workspace`);
    }

    return {
      kind: target.kind,
      targetId: target.id,
      targetLabel: target.label,
      checkedAt: new Date(),
      checkResult: PageEntryCitationCheckEnum.HOLDS,
    };
  }

  private async checkCode(
    workspaceId: string,
    input: PageEntryCitationInputDto,
    index: number,
  ): Promise<CitationDraft> {
    const path = cleanRepoPath(input.path);
    const range = parseLineRange(input.lines);
    const name = `${input.path ?? ''}${input.lines ? `:${input.lines}` : ''}`;

    if (!path) {
      throw refusal(
        index,
        `"${input.path}" is not a path inside a repository. Give it relative to the repository root`,
      );
    }

    if (!range) {
      throw refusal(index, `(${name}) needs lines, as "40-52" or "40"`);
    }

    if (input.sha !== undefined && !COMMIT_SHA.test(input.sha)) {
      throw refusal(
        index,
        `(${name}) names "${input.sha}", which is not a commit id`,
      );
    }

    const repo = await this.repoFor(workspaceId, path, input.repo, index);
    const base = {
      kind: PageEntryCitationKindEnum.CODE,
      moduleRepoId: repo.id,
      path,
      startLine: range.start,
      endLine: range.end,
    };

    let ref = input.sha ?? null;

    if (!ref) {
      const head = await this.files.head(repo);

      if ('unknown' in head) {
        return {
          ...base,
          commitSha: null,
          checkedAt: null,
          checkResult: PageEntryCitationCheckEnum.UNKNOWN,
        };
      }

      ref = head.sha;
    }

    const read = await this.files.read(repo, path, ref);
    const at = `${repo.fullName}:${path} at ${ref.slice(0, 12)}`;

    if ('unknown' in read) {
      return {
        ...base,
        commitSha: ref,
        checkedAt: null,
        checkResult: PageEntryCitationCheckEnum.UNKNOWN,
      };
    }

    if ('missing' in read) {
      throw refusal(
        index,
        `(${name}): ${at} does not exist. Check the path and that the commit is in the repository`,
      );
    }

    const cited = snippetAt(read.content, range);

    if ('error' in cited) {
      throw refusal(index, `(${name}): in ${at}, ${cited.error}`);
    }

    if (
      input.quote !== undefined &&
      !snippetContains(cited.snippet, input.quote)
    ) {
      throw refusal(
        index,
        `(${name}): the quoted text is not in lines ${formatLineRange(range)} of ${at}. Check the line numbers against that commit`,
      );
    }

    return {
      ...base,
      commitSha: ref,
      snippet: cited.snippet,
      snippetHash: cited.snippetHash,
      checkedAt: new Date(),
      checkedSha: ref,
      checkResult: PageEntryCitationCheckEnum.HOLDS,
    };
  }

  /**
   * The module repository a code citation is in.
   *
   * Named by the writer, or found from the path: the repository whose module
   * claims a folder the path is in, then a module that claims a whole
   * repository, then the workspace's only repository. More than one candidate
   * at any step is refused with the names, rather than guessed.
   */
  private async repoFor(
    workspaceId: string,
    path: string,
    named: string | undefined,
    index: number,
  ): Promise<CitedRepo> {
    const rows = await this.prisma.moduleRepo.findMany({
      where: { deleted: null, module: { workspaceId, deleted: null } },
      select: {
        id: true,
        fullName: true,
        externalRepoId: true,
        integrationAccountId: true,
        pathPrefixes: true,
      },
    });
    const repoKey = (row: (typeof rows)[number]) =>
      `${row.integrationAccountId ?? ''}|${row.externalRepoId}`;
    const pick = (candidates: typeof rows) => {
      const distinct = new Map(candidates.map((row) => [repoKey(row), row]));
      return [...distinct.values()];
    };

    let candidates: typeof rows;

    if (named !== undefined) {
      candidates = pick(
        rows.filter(
          (row) => row.fullName.toLowerCase() === named.trim().toLowerCase(),
        ),
      );

      if (candidates.length === 0) {
        throw refusal(
          index,
          `names repository "${named}", which no module in this workspace uses`,
        );
      }
    } else {
      const specific = pick(
        rows.filter(
          (row) =>
            row.pathPrefixes.length > 0 &&
            pathBelongsToModule(path, row.pathPrefixes),
        ),
      );
      const whole = pick(rows.filter((row) => row.pathPrefixes.length === 0));
      const all = pick(rows);

      candidates = specific.length ? specific : whole.length ? whole : all;

      if (candidates.length === 0) {
        throw refusal(
          index,
          'cites code, and no module in this workspace has a repository',
        );
      }
    }

    if (candidates.length > 1) {
      throw refusal(
        index,
        `could be in ${candidates.map((row) => row.fullName).join(' or ')}. Name the repository with "repo"`,
      );
    }

    return { ...candidates[0], workspaceId };
  }

  /**
   * An issue, linked pull request, comment or run, if it is in this workspace
   * and not deleted. A target in another workspace is not in this one, however
   * it was named.
   */
  private async findTarget(
    workspaceId: string,
    input: PageEntryCitationInputDto,
  ): Promise<{
    kind: PageEntryCitationKindEnum;
    id: string;
    label: string;
  } | null> {
    if (input.issue !== undefined) {
      const reference = input.issue.trim();
      const key = ISSUE_KEY.exec(reference);
      const issue = await this.prisma.issue.findFirst({
        where: {
          deleted: null,
          team: { workspaceId, deleted: null },
          ...(UUID.test(reference)
            ? { id: reference }
            : key
              ? {
                  number: Number(key[2]),
                  team: {
                    workspaceId,
                    deleted: null,
                    identifier: key[1].toUpperCase(),
                  },
                }
              : { id: '00000000-0000-0000-0000-000000000000' }),
        },
        select: {
          id: true,
          number: true,
          team: { select: { identifier: true } },
        },
      });

      return issue
        ? {
            kind: PageEntryCitationKindEnum.ISSUE,
            id: issue.id,
            label: `${issue.team.identifier}-${issue.number}`,
          }
        : null;
    }

    if (input.pullRequest !== undefined) {
      const reference = input.pullRequest.trim();
      const link = await this.prisma.linkedIssue.findFirst({
        where: {
          deleted: null,
          issue: { deleted: null, team: { workspaceId, deleted: null } },
          ...(UUID.test(reference) ? { id: reference } : { url: reference }),
        },
        select: { id: true, url: true },
      });

      return link
        ? {
            kind: PageEntryCitationKindEnum.PULL_REQUEST,
            id: link.id,
            label: link.url,
          }
        : null;
    }

    if (input.comment !== undefined) {
      const comment = await this.prisma.issueComment.findFirst({
        where: {
          id: input.comment,
          deleted: null,
          issue: { deleted: null, team: { workspaceId, deleted: null } },
        },
        select: { id: true },
      });

      return comment
        ? {
            kind: PageEntryCitationKindEnum.COMMENT,
            id: comment.id,
            label: comment.id,
          }
        : null;
    }

    if (input.run !== undefined) {
      const run = await this.prisma.agentRun.findFirst({
        where: { id: input.run, workspaceId, deleted: null },
        select: { id: true },
      });

      return run
        ? { kind: PageEntryCitationKindEnum.RUN, id: run.id, label: run.id }
        : null;
    }

    return null;
  }

  // ------------------------------------------------------------- re-checks

  /**
   * Checks an entry's citations against the code and the workspace as they
   * are now.
   *
   * A code citation is compared with its file at the head of the default
   * branch: held, moved (the lines are updated) or changed, or missing when
   * the file is gone. A changed one is put to the judge. A repository that
   * cannot be reached leaves the last result in place, since failing to read
   * the code says nothing about it. A non-code citation holds while its target
   * is in the workspace.
   */
  async recheck(entryId: string): Promise<{ checked: number }> {
    const entry = await this.entryWithCitations(entryId);

    if (!entry) {
      return { checked: 0 };
    }

    let checked = 0;

    for (const citation of entry.citations) {
      const update =
        citation.kind === PageEntryCitationKindEnum.CODE
          ? await this.recheckCode(entry, citation)
          : await this.recheckTarget(entry.page.workspaceId, citation);

      if (update) {
        await this.prisma.pageEntryCitation.update({
          where: { id: citation.id },
          data: update,
        });
        checked++;
      }
    }

    if (checked > 0) {
      await this.indexer?.entryChanged(entryId);
    }

    return { checked };
  }

  /**
   * Reads again the code citations that could not be read when they were
   * written. The write checked everything it could; this finishes the job.
   * Returns how many are still unread, so the caller can try again later.
   */
  async retryUnknown(entryId: string): Promise<{ stillUnknown: number }> {
    const entry = await this.entryWithCitations(entryId);

    if (!entry) {
      return { stillUnknown: 0 };
    }

    let stillUnknown = 0;
    let settled = 0;

    for (const citation of entry.citations) {
      if (
        citation.kind !== PageEntryCitationKindEnum.CODE ||
        citation.checkResult !== PageEntryCitationCheckEnum.UNKNOWN
      ) {
        continue;
      }

      const repo = await this.citedRepo(
        citation.moduleRepoId,
        entry.page.workspaceId,
      );
      const range = rangeOf(citation);
      const head = citation.commitSha
        ? null
        : repo
          ? await this.files.head(repo)
          : null;
      const ref =
        citation.commitSha ?? (head && 'sha' in head ? head.sha : null);
      const read: RepoFileRead =
        repo && ref && citation.path
          ? await this.files.read(repo, citation.path, ref)
          : { unknown: true, reason: 'nothing to read yet' };

      if ('unknown' in read || !range || !ref) {
        // A repository removed from the module leaves nothing to read ever
        // again; that is a missing citation rather than one to keep retrying.
        if (!repo) {
          await this.prisma.pageEntryCitation.update({
            where: { id: citation.id },
            data: {
              checkResult: PageEntryCitationCheckEnum.MISSING,
              checkedAt: new Date(),
            },
          });
          settled++;
          continue;
        }

        stillUnknown++;
        continue;
      }

      const cited = 'content' in read ? snippetAt(read.content, range) : null;

      await this.prisma.pageEntryCitation.update({
        where: { id: citation.id },
        data:
          cited && 'snippet' in cited
            ? {
                commitSha: ref,
                snippet: cited.snippet,
                snippetHash: cited.snippetHash,
                checkedAt: new Date(),
                checkedSha: ref,
                checkResult: PageEntryCitationCheckEnum.HOLDS,
              }
            : {
                // The file or the cited lines are not at the commit: the
                // citation never held.
                commitSha: ref,
                checkedAt: new Date(),
                checkedSha: ref,
                checkResult: PageEntryCitationCheckEnum.MISSING,
              },
      });
      settled++;
    }

    if (settled > 0) {
      await this.indexer?.entryChanged(entryId);
    }

    return { stillUnknown };
  }

  private async recheckCode(
    entry: NonNullable<
      Awaited<ReturnType<EntryCitationsService['entryWithCitations']>>
    >,
    citation: CitationRow,
  ) {
    const range = rangeOf(citation);
    const repo = await this.citedRepo(
      citation.moduleRepoId,
      entry.page.workspaceId,
    );

    // Never read: that is the retry's job, which reads it at its own commit.
    if (!citation.snippet || !range || !citation.path || !repo) {
      return null;
    }

    const head = await this.files.head(repo);

    if ('unknown' in head) {
      return null;
    }

    const read = await this.files.read(repo, citation.path, head.sha);

    if ('unknown' in read) {
      return null;
    }

    const checked = { checkedAt: new Date(), checkedSha: head.sha };
    const clearJudgment = {
      judgment: null as PageEntryCitationJudgmentEnum | null,
      judgeModel: null as string | null,
      judgeLines: null as string | null,
      judgeReason: null as string | null,
    };

    if ('missing' in read) {
      return {
        ...checked,
        ...clearJudgment,
        checkResult: PageEntryCitationCheckEnum.MISSING,
      };
    }

    const found = relocate(citation.snippet, read.content, range);

    if (found.result !== PageEntryCitationCheckEnum.CHANGED) {
      return {
        ...checked,
        ...clearJudgment,
        checkResult: found.result,
        startLine: found.range.start,
        endLine: found.range.end,
      };
    }

    const lines = fileLines(read.content);
    const from = Math.max(1, range.start - JUDGE_CONTEXT_LINES);
    const to = Math.min(lines.length, range.end + JUDGE_CONTEXT_LINES);
    const verdict = await this.judge.judge({
      claim: entry.content,
      path: citation.path,
      snippet: citation.snippet,
      region: { startLine: from, lines: lines.slice(from - 1, to) },
      writerModel: await this.writerModel(entry),
    });

    return {
      ...checked,
      checkResult: PageEntryCitationCheckEnum.CHANGED,
      judgment: verdict.verdict,
      judgeModel: verdict.model,
      judgeLines: verdict.lines,
      judgeReason: verdict.reason,
    };
  }

  private async recheckTarget(workspaceId: string, citation: CitationRow) {
    const reference = citation.targetId ?? '';
    const input: PageEntryCitationInputDto =
      citation.kind === PageEntryCitationKindEnum.ISSUE
        ? { issue: reference }
        : citation.kind === PageEntryCitationKindEnum.PULL_REQUEST
          ? { pullRequest: reference }
          : citation.kind === PageEntryCitationKindEnum.COMMENT
            ? { comment: reference }
            : { run: reference };
    const target = UUID.test(reference)
      ? await this.findTarget(workspaceId, input)
      : null;

    return {
      checkedAt: new Date(),
      checkResult: target
        ? PageEntryCitationCheckEnum.HOLDS
        : PageEntryCitationCheckEnum.MISSING,
    };
  }

  /**
   * The model that wrote an entry, when a hosted run wrote it. The session id
   * such a run writes with is its run id, and the run records its model.
   */
  private async writerModel(entry: {
    sourceSession: string | null;
    page: { workspaceId: string };
  }) {
    if (!entry.sourceSession || !UUID.test(entry.sourceSession)) {
      return null;
    }

    const run = await this.prisma.agentRun.findFirst({
      where: { id: entry.sourceSession, workspaceId: entry.page.workspaceId },
      select: { modelId: true },
    });

    return run?.modelId ?? null;
  }

  private entryWithCitations(entryId: string) {
    return this.prisma.pageEntry.findFirst({
      where: { id: entryId, deleted: null },
      select: {
        id: true,
        content: true,
        sourceSession: true,
        page: { select: { workspaceId: true } },
        citations: {
          select: {
            id: true,
            kind: true,
            moduleRepoId: true,
            path: true,
            commitSha: true,
            startLine: true,
            endLine: true,
            snippet: true,
            targetId: true,
            checkResult: true,
          },
        },
      },
    });
  }

  private async citedRepo(
    moduleRepoId: string | null,
    workspaceId: string,
  ): Promise<CitedRepo | null> {
    if (!moduleRepoId) {
      return null;
    }

    const row = await this.prisma.moduleRepo.findFirst({
      where: {
        id: moduleRepoId,
        deleted: null,
        module: { workspaceId, deleted: null },
      },
      select: {
        id: true,
        fullName: true,
        externalRepoId: true,
        integrationAccountId: true,
      },
    });

    return row ? { ...row, workspaceId } : null;
  }
}

function rangeOf(citation: {
  startLine: number | null;
  endLine: number | null;
}): LineRange | null {
  return citation.startLine &&
    citation.endLine &&
    citation.endLine >= citation.startLine
    ? { start: citation.startLine, end: citation.endLine }
    : null;
}

function describeTarget(input: PageEntryCitationInputDto): string {
  if (input.issue !== undefined) {
    return `issue "${input.issue}"`;
  }
  if (input.pullRequest !== undefined) {
    return `pull request "${input.pullRequest}"`;
  }
  if (input.comment !== undefined) {
    return `comment "${input.comment}"`;
  }
  return `run "${input.run}"`;
}

/**
 * A 422 naming the citation by its position, counted from 1 as the message
 * counts it, so the writer can find it in what it sent. Nothing was written.
 */
function refusal(index: number, reason: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    status: 'citation-failed',
    citation: index + 1,
    message: `Nothing was written: citation ${index + 1} ${reason}.`,
  });
}
