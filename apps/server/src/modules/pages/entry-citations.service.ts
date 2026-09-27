import { InjectQueue } from '@nestjs/bull';
import {
  Injectable,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PageEntryStatus, Prisma } from '@prisma/client';
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
  type RepoHead,
} from 'integrations/repo-files';
import { PrismaService } from 'nestjs-prisma';

import { pathBelongsToModule } from 'modules/modules/module-routing';

import CitationJudge from './citation-judge';
import {
  formatLineRange,
  fileLines,
  hashSnippet,
  parseLineRange,
  relocate,
  snippetAt,
  snippetContains,
  type LineRange,
} from './citation-matching';
import KnowledgeIndexService from './knowledge-index.service';
import {
  CODE_LANDED_JOB,
  type CodeLandedJob,
  codeLandedJobOptions,
  PAGES_QUEUE,
  RETRY_CITATIONS_JOB,
  retryCitationsJobOptions,
} from './pages.interface';
import RepoFileSourceService, {
  type CitedRepo,
  type RepoFileSource,
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
  /** A quote the write could not check, kept until the lines are read. */
  pendingQuote?: string | null;
}

/**
 * The repository reads of one write or check.
 *
 * Each repository's head is resolved once, however many of its files are
 * cited. A repository that does not answer is not asked again in the same
 * operation: the rest of its citations are unread too, rather than each
 * waiting out a timeout of its own, since a write waits on every one. A file
 * unread for a reason of its own (too large to check) says nothing about the
 * repository and stops nothing.
 */
class RepoReads {
  private heads = new Map<string, Promise<RepoHead>>();
  private asked = new Map<string, Date>();
  private down = new Map<string, string>();

  constructor(private files: RepoFileSource) {}

  head(repo: CitedRepo): Promise<RepoHead> {
    const key = repoKey(repo);
    let head = this.heads.get(key);

    if (!head) {
      this.asked.set(key, new Date());
      head = this.ask(key, () => this.files.head(repo));
      this.heads.set(key, head);
    }

    return head;
  }

  /**
   * When a repository's head was asked for. Every change that had landed by
   * then is in the head it answered, however long the operation reads from
   * it afterwards, so this is the time a reading of that head is stamped
   * with: a reading stamped later never read less.
   */
  headAskedAt(repo: CitedRepo): Date {
    return this.asked.get(repoKey(repo)) ?? new Date();
  }

  read(repo: CitedRepo, path: string, ref: string): Promise<RepoFileRead> {
    return this.ask(repoKey(repo), () => this.files.read(repo, path, ref));
  }

  private async ask<T extends RepoFileRead | RepoHead>(
    key: string,
    call: () => Promise<T>,
  ): Promise<T | { unknown: true; reason: string }> {
    const reason = this.down.get(key);

    if (reason !== undefined) {
      return { unknown: true, reason };
    }

    const answer = await call();

    if ('unknown' in answer && !('thisFileOnly' in answer)) {
      this.down.set(key, answer.reason);
    }

    return answer;
  }
}

/**
 * Holds an entry's lock until the transaction ends. Whatever stores a
 * reading of its code citations after writing, or acts on those readings,
 * holds it, and acts on the readings stored when it holds it, so what is
 * acted on is what is stored.
 */
export async function lockEntry(
  tx: Prisma.TransactionClient,
  entryId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`knowledge-entry:${entryId}`}, 0))`;
}

/**
 * Holds an entry's row until the transaction ends. A person changing the
 * entry meanwhile waits, so its words and status, read after this, are the
 * ones whatever the transaction does is done to. Not a key lock: rows that
 * refer to the entry, such as its uses when it is served, are still
 * written meanwhile.
 */
export async function lockEntryRow(
  tx: Prisma.TransactionClient,
  entryId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "PageEntry" WHERE "id" = ${entryId} FOR NO KEY UPDATE`;
}

/**
 * A citation with no stored reading, or one older than a reading stamped
 * `checkedAt`: the newer reading wins, whichever is stored first.
 *
 * A reading of a head is stamped with when the head was asked for, and a
 * reading of the commit a citation cites with when the citation was
 * written, which is older than any head read since. An unread citation
 * that names no commit is read at the head, and stamped as a head is. Stamps come from the
 * clocks of the servers that read, which keep time with each other to
 * within milliseconds. Two readings of heads could be put in the wrong
 * order only if the heads were asked for within that time of each other
 * and a change landed between the two.
 */
export function readBefore(
  checkedAt: Date,
): Prisma.PageEntryCitationWhereInput {
  return { OR: [{ checkedAt: null }, { checkedAt: { lt: checkedAt } }] };
}

/** One repository, however many modules list it. */
function repoKey(repo: {
  integrationAccountId: string | null;
  externalRepoId: string;
}): string {
  return `${repo.integrationAccountId ?? ''}|${repo.externalRepoId}`;
}

/** Lines of context either side of a changed citation, shown to the judge. */
const JUDGE_CONTEXT_LINES = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ISSUE_KEY = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;

/** A code citation checked against a change that landed, and what it found. */
export interface LandedCheck {
  citationId: string;
  entryId: string;
  /** The entry's status when the change was checked. */
  entryStatus: PageEntryStatus;
  path: string;
  /** The lines it cited before this check. */
  startLine: number;
  endLine: number;
  /** The code as it was cited. */
  snippet: string;
  /** The module repository it was read from; null when none lists it now. */
  moduleRepoId: string | null;
  /** The commit it was read at; null when there was nothing to read. */
  readSha: string | null;
  result: PageEntryCitationCheckEnum;
  judgment: PageEntryCitationJudgmentEnum | null;
  judgeModel: string | null;
  judgeReason: string | null;
  /** The entry's content hash the judge read; null when none judged. */
  judgedContentHash: string | null;
  /** A hash of the code the judge read; null when none judged. */
  judgedCodeHash: string | null;
  /** When the head it read was asked for, as stored on the citation. */
  checkedAt: Date;
  /**
   * What to store on the citation; null for a reading already stored, which
   * is acted on as it is.
   */
  update: Prisma.PageEntryCitationUncheckedUpdateInput | null;
}

/** A code citation's stored reading, as acting on it again needs. */
export const STORED_READING_SELECT = {
  id: true,
  moduleRepoId: true,
  path: true,
  startLine: true,
  endLine: true,
  snippet: true,
  checkedAt: true,
  checkedSha: true,
  checkResult: true,
  judgment: true,
  judgeModel: true,
  judgeReason: true,
  judgedContentHash: true,
  judgedCodeHash: true,
} as const;

type StoredReading = Prisma.PageEntryCitationGetPayload<{
  select: typeof STORED_READING_SELECT;
}>;

/**
 * A citation's stored reading, as a check to act on: one already read and
 * stored, by another job or a re-check, rather than read now. Null when
 * there is no reading to act on.
 */
export function storedCheck(
  row: StoredReading,
  entry: { id: string; status: PageEntryStatus },
): LandedCheck | null {
  const range = rangeOf(row);

  if (
    !range ||
    !row.path ||
    !row.snippet ||
    !row.checkedAt ||
    !row.checkResult ||
    row.checkResult === PageEntryCitationCheckEnum.UNKNOWN
  ) {
    return null;
  }

  return {
    citationId: row.id,
    entryId: entry.id,
    entryStatus: entry.status,
    path: row.path,
    startLine: range.start,
    endLine: range.end,
    snippet: row.snippet,
    moduleRepoId: row.moduleRepoId,
    readSha: row.checkedSha,
    result: row.checkResult as PageEntryCitationCheckEnum,
    judgment: row.judgment as PageEntryCitationJudgmentEnum | null,
    judgeModel: row.judgeModel,
    judgeReason: row.judgeReason,
    judgedContentHash: row.judgedContentHash,
    judgedCodeHash: row.judgedCodeHash,
    checkedAt: row.checkedAt,
    update: null,
  };
}

/**
 * Whether a person has acted on an entry since one of its citations was
 * read: put it back after the gardener took it out of use, or reworded it,
 * so a judgment read words it no longer has. Nothing acts on such a
 * reading. The person decided with more than it knew, and the citation is
 * read again instead.
 */
export function readBeforeActedOn(
  reading: {
    checkedAt: Date;
    judgment: PageEntryCitationJudgmentEnum | null;
    judgedContentHash: string | null;
  },
  entry: { contentHash: string | null },
  putBack: Date | null,
): boolean {
  return (
    (putBack !== null && reading.checkedAt < putBack) ||
    (reading.judgment !== null &&
      reading.judgedContentHash !== entry.contentHash)
  );
}

/**
 * When a person last put each entry back after the gardener took it out of
 * use: the newest undoing of its maintenance rows.
 */
export async function putBackAt(
  client: Prisma.TransactionClient,
  entryIds: string[],
): Promise<Map<string, Date>> {
  const undone = entryIds.length
    ? await client.pageEntryMaintenance.findMany({
        where: { entryId: { in: entryIds }, reversedAt: { not: null } },
        select: { entryId: true, reversedAt: true },
      })
    : [];
  const latest = new Map<string, Date>();

  for (const { entryId, reversedAt } of undone) {
    const known = latest.get(entryId);

    if (reversedAt && (!known || reversedAt > known)) {
      latest.set(entryId, reversedAt);
    }
  }

  return latest;
}

/** An entry's content and origin, as checking one of its citations needs. */
interface CheckedEntry {
  content: string;
  contentHash: string | null;
  sourceSession: string | null;
  page: { workspaceId: string };
}

/** A citation read for the first time: what was read, and what was found. */
interface FirstReading {
  citation: CitationRow;
  result: PageEntryCitationCheckEnum;
  /** The commit read, when there was one to read. */
  sha: string | null;
}

interface CitationRow {
  id: string;
  createdAt: Date;
  kind: string;
  moduleRepoId: string | null;
  path: string | null;
  commitSha: string | null;
  startLine: number | null;
  endLine: number | null;
  snippet: string | null;
  targetId: string | null;
  checkResult: string | null;
  pendingQuote: string | null;
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
    const reads = new RepoReads(this.files);

    for (const [index, input] of inputs.entries()) {
      drafts.push(await this.checkOne(workspaceId, input, index, reads));
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
    reads: RepoReads,
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
      return this.checkCode(workspaceId, input, index, reads);
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
    reads: RepoReads,
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
    // Unread for now. The quote cannot be checked either, so it is kept, and
    // the retry checks it when it reads the lines: a quote is what catches
    // wrong line numbers, and they are no less wrong for the source being
    // down when they were written.
    const unread = (commitSha: string | null): CitationDraft => ({
      ...base,
      commitSha,
      checkedAt: null,
      checkResult: PageEntryCitationCheckEnum.UNKNOWN,
      pendingQuote: input.quote ?? null,
    });

    let ref = input.sha ?? null;

    if (!ref) {
      const head = await reads.head(repo);

      if ('unknown' in head) {
        return unread(null);
      }

      ref = head.sha;
    }

    const read = await reads.read(repo, path, ref);
    const at = `${repo.fullName}:${path} at ${ref.slice(0, 12)}`;

    if ('unknown' in read) {
      return unread(ref);
    }

    if ('missing' in read) {
      throw refusal(
        index,
        `(${name}): ${at} is not a file there. Check the path, and that the commit is in the repository`,
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
   *
   * What it finds is stored, not acted on. A reading is stored only over an
   * older one, under the entry's lock: a landed change's check may have read
   * a newer head meanwhile, and acts on what is stored while it holds the
   * same lock, so a reading this stores in time is acted on there. A
   * citation never read is read at the commit it cites, as the retry reads
   * it, and stored only while it is still unread.
   */
  async recheck(entryId: string): Promise<{ checked: number }> {
    const entry = await this.entryWithCitations(entryId);

    if (!entry) {
      return { checked: 0 };
    }

    const reads = new RepoReads(this.files);
    const found: Array<{
      id: string;
      where: Prisma.PageEntryCitationWhereInput;
      update: Prisma.PageEntryCitationUncheckedUpdateInput;
      /** Read for the first time, at the commit it cites. */
      firstRead?: FirstReading;
    }> = [];

    for (const citation of entry.citations) {
      if (
        citation.kind === PageEntryCitationKindEnum.CODE &&
        citation.checkResult === PageEntryCitationCheckEnum.UNKNOWN
      ) {
        // Never read, and the retries may have run out: read it now, at the
        // commit it cites, as the retry would have.
        const update = await this.readUnread(
          entry.page.workspaceId,
          citation,
          reads,
        );

        if (update) {
          found.push({
            id: citation.id,
            where: STILL_UNREAD,
            update,
            firstRead: firstReading(citation, update),
          });
        }

        continue;
      }

      const update =
        citation.kind !== PageEntryCitationKindEnum.CODE
          ? await this.recheckTarget(entry.page.workspaceId, citation)
          : await this.recheckCode(entry, citation, reads);

      if (update) {
        found.push({
          id: citation.id,
          where: readBefore(update.checkedAt),
          update,
        });
      }
    }

    const firstReads: FirstReading[] = [];
    const checked = found.length
      ? await this.prisma.$transaction(async (tx) => {
          await lockEntry(tx, entryId);
          let stored = 0;

          for (const { id, where, update, firstRead } of found) {
            const { count } = await tx.pageEntryCitation.updateMany({
              where: { id, ...where },
              data: update,
            });
            stored += count;

            if (count > 0 && firstRead) {
              firstReads.push(firstRead);
            }
          }

          return stored;
        })
      : 0;

    if (checked > 0) {
      await this.indexer?.entryChanged(entryId);
    }

    await this.checkSinceCited(entry.page.workspaceId, firstReads, reads);

    return { checked };
  }

  /**
   * Checks the code citations a change that landed on a repository's default
   * branch touches: those of live entries, in use or waiting, citing one of
   * the changed files in that repository under any module that lists it.
   *
   * Each is read at the head of the default branch, which contains the
   * change: it is the change's own commit unless more has landed since.
   * Reading the change's commit when newer ones have landed could put back
   * what a later check found, since changes are handled by several workers
   * and not always in the order they landed. Each reading is stamped with
   * when the head was asked for, so the caller can keep the newest.
   *
   * A citation already read at the change's own commit is not read again:
   * that reading is what reading it again would find, and it comes back as
   * it is stored, to be acted on like any other. So while the change is
   * still the head, the same commit reported twice (a merged pull request
   * and the push of its merge commit) is read and judged once; once more
   * has landed, the second report reads the newer head. A retry reads only
   * what it could not read before, and a reading stored by something that
   * does not act on it, such as a re-check after a harmful signal, is still
   * acted on. A reading taken before a person last acted on the entry is
   * read again, as nothing acts on it. A citation never read, or one that
   * never held, says nothing about this change and is left to its retry,
   * which hands a citation found to hold at an older commit back here.
   *
   * Nothing is written: each check comes back with what to store, for the
   * caller to store with whatever it does about the result, so a failure
   * between the two cannot leave a result stored and not acted on. Returns
   * how many could not be read, so the caller can try again.
   */
  async recheckLanded(
    change: CodeLandedJob,
  ): Promise<{ checks: LandedCheck[]; unread: number }> {
    const paths = [
      ...new Set(
        change.changedPaths
          .map((path) => cleanRepoPath(path))
          .filter((path): path is string => path !== null),
      ),
    ];

    if (paths.length === 0) {
      return { checks: [], unread: 0 };
    }

    // Deleted rows too: a citation keeps the row it was written against, and
    // is read through whichever row lists the repository now.
    const rows = await this.prisma.moduleRepo.findMany({
      where: {
        externalRepoId: change.externalRepoId,
        module: { workspaceId: change.workspaceId },
      },
      select: { id: true },
    });

    if (rows.length === 0) {
      return { checks: [], unread: 0 };
    }

    const citations = await this.prisma.pageEntryCitation.findMany({
      where: {
        kind: PageEntryCitationKindEnum.CODE,
        moduleRepoId: { in: rows.map((row) => row.id) },
        path: { in: paths },
        snippet: { not: null },
        checkResult: { not: PageEntryCitationCheckEnum.UNKNOWN },
        entry: {
          deleted: null,
          status: { in: [PageEntryStatus.STANDING, PageEntryStatus.PROPOSED] },
          page: { workspaceId: change.workspaceId, deleted: null },
        },
      },
      orderBy: { id: 'asc' },
      select: {
        ...CITATION_SELECT,
        ...STORED_READING_SELECT,
        entry: {
          select: {
            id: true,
            status: true,
            content: true,
            contentHash: true,
            sourceSession: true,
            page: { select: { workspaceId: true } },
          },
        },
      },
    });

    const checks: LandedCheck[] = [];
    const reads = new RepoReads(this.files);
    const putBack = citations.some(
      (citation) => citation.checkedSha === change.sha,
    )
      ? await putBackAt(this.prisma, [
          ...new Set(citations.map((citation) => citation.entry.id)),
        ])
      : new Map<string, Date>();
    let unread = 0;

    for (const citation of citations) {
      const range = rangeOf(citation);

      if (!range || !citation.path || !citation.snippet) {
        continue;
      }

      const stored =
        citation.checkedSha === change.sha
          ? storedCheck(citation, citation.entry)
          : null;

      if (
        stored &&
        !readBeforeActedOn(
          stored,
          citation.entry,
          putBack.get(citation.entry.id) ?? null,
        )
      ) {
        checks.push(stored);
        continue;
      }

      const update = await this.recheckCode(citation.entry, citation, reads);

      if (!update) {
        unread++;
        continue;
      }

      checks.push({
        citationId: citation.id,
        entryId: citation.entry.id,
        entryStatus: citation.entry.status,
        path: citation.path,
        startLine: range.start,
        endLine: range.end,
        snippet: citation.snippet,
        moduleRepoId: 'moduleRepoId' in update ? update.moduleRepoId : null,
        readSha: 'checkedSha' in update ? update.checkedSha : null,
        result: update.checkResult,
        judgment: update.judgment,
        judgeModel: update.judgeModel,
        judgeReason: update.judgeReason,
        judgedContentHash: update.judgedContentHash,
        judgedCodeHash: update.judgedCodeHash,
        checkedAt: update.checkedAt,
        update,
      });
    }

    return { checks, unread };
  }

  /**
   * Reads again the code citations that could not be read when they were
   * written. The write checked everything it could; this finishes the job.
   * Returns how many are still unread, so the caller can try again later.
   *
   * A reading is stored only while the citation is still unread, under the
   * entry's lock. It is of the commit the citation cites, older than any
   * head a landed change's check or a re-check has read since, and must not
   * replace what they found. The changes that landed since that commit
   * passed the citation over while it was unread, so a citation found to
   * hold there is handed to the landed-change check, at the head.
   */
  async retryUnknown(entryId: string): Promise<{ stillUnknown: number }> {
    const entry = await this.entryWithCitations(entryId);

    if (!entry) {
      return { stillUnknown: 0 };
    }

    let stillUnknown = 0;
    const found: Array<{
      update: Prisma.PageEntryCitationUncheckedUpdateInput;
      firstRead: FirstReading;
    }> = [];
    const reads = new RepoReads(this.files);

    for (const citation of entry.citations) {
      if (
        citation.kind !== PageEntryCitationKindEnum.CODE ||
        citation.checkResult !== PageEntryCitationCheckEnum.UNKNOWN
      ) {
        continue;
      }

      const update = await this.readUnread(
        entry.page.workspaceId,
        citation,
        reads,
      );

      if (!update) {
        stillUnknown++;
        continue;
      }

      found.push({ update, firstRead: firstReading(citation, update) });
    }

    const firstReads: FirstReading[] = found.length
      ? await this.prisma.$transaction(async (tx) => {
          await lockEntry(tx, entryId);
          const stored: FirstReading[] = [];

          for (const { update, firstRead } of found) {
            const { count } = await tx.pageEntryCitation.updateMany({
              where: { id: firstRead.citation.id, ...STILL_UNREAD },
              data: update,
            });

            if (count > 0) {
              stored.push(firstRead);
            }
          }

          return stored;
        })
      : [];

    if (firstReads.length > 0) {
      await this.indexer?.entryChanged(entryId);
    }

    await this.checkSinceCited(entry.page.workspaceId, firstReads, reads);

    return { stillUnknown };
  }

  /**
   * Hands the landed-change check each citation just read for the first
   * time, and found to hold, at a commit the default branch has since moved
   * past: the commit it cites. The checks of the changes that landed since
   * passed it over while it was unread, so none of them was checked against
   * it: the check reads it at the head, as they would have, and acts on what
   * it finds as they would have. A citation that named no commit was read
   * at the head, and has nothing to hand on. Queued under a job id of its
   * own, so a check of the same commit waiting with other files does not
   * stand in for it.
   */
  private async checkSinceCited(
    workspaceId: string,
    firstReads: FirstReading[],
    reads: RepoReads,
  ): Promise<void> {
    for (const { citation, result, sha } of firstReads) {
      if (!citation.path || result !== PageEntryCitationCheckEnum.HOLDS) {
        continue;
      }

      const repo = await this.citedRepo(citation.moduleRepoId, workspaceId);

      if (!repo) {
        continue;
      }

      const head = await reads.head(repo);

      if ('unknown' in head || head.sha === sha) {
        continue;
      }

      const job: CodeLandedJob = {
        workspaceId,
        externalRepoId: repo.externalRepoId,
        sha: head.sha,
        changedPaths: [citation.path],
      };

      try {
        await this.pagesQueue?.add(CODE_LANDED_JOB, job, {
          ...codeLandedJobOptions(job),
          jobId: `${CODE_LANDED_JOB}:citation:${citation.id}:${head.sha}`,
        });
      } catch {
        // The citation holds at the commit it cites; the next change to its
        // file checks it at the head.
      }
    }
  }

  /**
   * Reads a code citation that has never been read, at the commit it cites,
   * or the head when it named none. What to store, or null while the source
   * still cannot be read.
   *
   * What the write would have refused, had it been able to read the code,
   * never held and is MISSING: the file or the lines are not at the commit,
   * or they do not say what the writer quoted. It keeps no snippet, so later
   * checks cannot turn it into a citation that holds.
   */
  private async readUnread(
    workspaceId: string,
    citation: CitationRow,
    reads: RepoReads,
  ) {
    const repo = await this.citedRepo(citation.moduleRepoId, workspaceId);

    // A repository removed from the workspace leaves nothing to read, now or
    // later.
    if (!repo) {
      return removedRepo();
    }

    let ref = citation.commitSha;

    if (!ref) {
      const head = await reads.head(repo);

      if ('unknown' in head) {
        return null;
      }

      ref = head.sha;
    }

    const range = rangeOf(citation);
    const read = citation.path
      ? await reads.read(repo, citation.path, ref)
      : ({ missing: true } as const);

    if ('unknown' in read) {
      return null;
    }

    const checked = {
      moduleRepoId: repo.id,
      commitSha: ref,
      // Of the commit it cites, when the citation was written: the reading
      // says whether the claim held at the commit it was written against,
      // and so never outranks a reading of a head, which is newer, whenever
      // this one finishes. Of the head, when that was asked for, as any
      // reading of a head is.
      checkedAt: citation.commitSha
        ? citation.createdAt
        : reads.headAskedAt(repo),
      checkedSha: ref,
      pendingQuote: null as string | null,
    };
    const cited =
      'content' in read && range ? snippetAt(read.content, range) : null;

    if (
      !cited ||
      'error' in cited ||
      (citation.pendingQuote !== null &&
        !snippetContains(cited.snippet, citation.pendingQuote))
    ) {
      return { ...checked, checkResult: PageEntryCitationCheckEnum.MISSING };
    }

    return {
      ...checked,
      snippet: cited.snippet,
      snippetHash: cited.snippetHash,
      checkResult: PageEntryCitationCheckEnum.HOLDS,
    };
  }

  private async recheckCode(
    entry: CheckedEntry,
    citation: CitationRow,
    reads: RepoReads,
  ) {
    const range = rangeOf(citation);
    const repo = await this.citedRepo(
      citation.moduleRepoId,
      entry.page.workspaceId,
    );

    // Gone from the workspace, as the retry treats it: the cited code is no
    // longer anywhere the workspace can read, and leaving the last result
    // would serve the entry as grounded on code nobody checks.
    if (!repo) {
      return { ...removedRepo(), ...NO_JUDGMENT };
    }

    // Never held (the retry found nothing to hold): nothing to compare.
    if (!citation.snippet || !range || !citation.path) {
      return null;
    }

    const head = await reads.head(repo);

    if ('unknown' in head) {
      return null;
    }

    const read = await reads.read(repo, citation.path, head.sha);

    if ('unknown' in read) {
      return null;
    }

    const checked = {
      moduleRepoId: repo.id,
      checkedAt: reads.headAskedAt(repo),
      checkedSha: head.sha,
    };

    if ('missing' in read) {
      return {
        ...checked,
        ...NO_JUDGMENT,
        checkResult: PageEntryCitationCheckEnum.MISSING,
      };
    }

    const found = relocate(citation.snippet, read.content, range);

    if (found.result !== PageEntryCitationCheckEnum.CHANGED) {
      return {
        ...checked,
        ...NO_JUDGMENT,
        checkResult: found.result,
        startLine: found.range.start,
        endLine: found.range.end,
      };
    }

    // Around the old lines, or the end of a file that has shrunk past them,
    // so the judge always has code to read.
    const lines = fileLines(read.content);
    const to = Math.min(lines.length, range.end + JUDGE_CONTEXT_LINES);
    const from = Math.max(1, Math.min(range.start, to) - JUDGE_CONTEXT_LINES);
    const region = { startLine: from, lines: lines.slice(from - 1, to) };
    const verdict = await this.judge.judge({
      claim: entry.content,
      path: citation.path,
      snippet: citation.snippet,
      region,
      writerModel: await this.writerModel(entry),
    });

    return {
      ...checked,
      checkResult: PageEntryCitationCheckEnum.CHANGED,
      judgment: verdict.verdict,
      judgeModel: verdict.model,
      judgeLines: verdict.lines,
      judgeReason: verdict.reason,
      judgedContentHash: entry.contentHash,
      judgedCodeHash: hashSnippet(
        JSON.stringify([citation.snippet, region.startLine, region.lines]),
      ),
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
        contentHash: true,
        sourceSession: true,
        page: { select: { workspaceId: true } },
        citations: { select: CITATION_SELECT },
      },
    });
  }

  /**
   * The repository a code citation is read from.
   *
   * The row it was written against, while that is live. A row goes when its
   * module is deleted or the repository moves to another module, and the
   * repository itself is then often still in the workspace under another
   * row: that one is used, and the citation is moved to it. Only a
   * repository no module in the workspace lists any more has nothing to read.
   */
  private async citedRepo(
    moduleRepoId: string | null,
    workspaceId: string,
  ): Promise<CitedRepo | null> {
    if (!moduleRepoId) {
      return null;
    }

    const select = {
      id: true,
      fullName: true,
      externalRepoId: true,
      integrationAccountId: true,
    } as const;
    const row = await this.prisma.moduleRepo.findFirst({
      where: { id: moduleRepoId, module: { workspaceId } },
      select: {
        ...select,
        deleted: true,
        module: { select: { deleted: true } },
      },
    });

    if (!row) {
      return null;
    }

    if (!row.deleted && !row.module.deleted) {
      return {
        id: row.id,
        fullName: row.fullName,
        externalRepoId: row.externalRepoId,
        integrationAccountId: row.integrationAccountId,
        workspaceId,
      };
    }

    const live = await this.prisma.moduleRepo.findFirst({
      where: {
        deleted: null,
        externalRepoId: row.externalRepoId,
        integrationAccountId: row.integrationAccountId,
        module: { workspaceId, deleted: null },
      },
      select,
    });

    return live ? { ...live, workspaceId } : null;
  }
}

const CITATION_SELECT = {
  id: true,
  createdAt: true,
  kind: true,
  moduleRepoId: true,
  path: true,
  commitSha: true,
  startLine: true,
  endLine: true,
  snippet: true,
  targetId: true,
  checkResult: true,
  pendingQuote: true,
} as const;

/** A judgment only describes a CHANGED check; any other clears it. */
const NO_JUDGMENT = {
  judgment: null as PageEntryCitationJudgmentEnum | null,
  judgeModel: null as string | null,
  judgeLines: null as string | null,
  judgeReason: null as string | null,
  judgedContentHash: null as string | null,
  judgedCodeHash: null as string | null,
};

/**
 * A citation never read. A reading of the commit it cites is stored only
 * over this: any other reading is of a head, which is newer.
 */
const STILL_UNREAD: Prisma.PageEntryCitationWhereInput = {
  checkResult: PageEntryCitationCheckEnum.UNKNOWN,
};

/**
 * What a first reading read and found, from what it stores. A removed
 * repository stores no commit, as there is none left to read.
 */
function firstReading(
  citation: CitationRow,
  update: { checkResult: PageEntryCitationCheckEnum; checkedSha?: string },
): FirstReading {
  return {
    citation,
    result: update.checkResult,
    sha: update.checkedSha ?? null,
  };
}

function removedRepo() {
  return {
    checkedAt: new Date(),
    checkResult: PageEntryCitationCheckEnum.MISSING,
    pendingQuote: null as string | null,
  };
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
