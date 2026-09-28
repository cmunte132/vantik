import { InjectQueue } from '@nestjs/bull';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  BulkUpdatePageEntriesDto,
  CreatePageEntryDto,
  PageEntry,
  PageEntryCitationKindEnum,
  PageEntryPolicyEnum,
  PageEntryStatusEnum,
  UpdatePageEntryDto,
  UserTypeEnum,
} from '@vantikhq/types';
import { PageEntryProposalState, Prisma } from '@prisma/client';
import type { Queue } from 'bull';
import { createHash } from 'node:crypto';
import { PrismaService } from 'nestjs-prisma';

import { modulesForScope } from 'modules/modules/module-routing';
import { VectorService } from 'modules/vector/vector.service';
import type { KnowledgeSearchHit } from 'modules/vector/vector.interface';

import EntryCitationsService, {
  type CitationDraft,
} from './entry-citations.service';
import KnowledgeIndexService from './knowledge-index.service';
import {
  entryProof,
  PROOF_CITATION_SELECT,
  type ProofRow,
} from './knowledge-proof';
import {
  ALLOWED_STATUS_TRANSITIONS,
  PAGES_QUEUE,
  PROPOSED_ENTRY_BUDGET,
  PROPOSED_ENTRY_EXPIRY_DAYS,
  STANDING_ENTRY_DECAY_DAYS,
  type ServedTo,
  TRIAGE_ENTRY_JOB,
  triageEntryJobOptions,
  WriterIdentity,
} from './pages.interface';
import KnowledgeAgreementService from './triage/knowledge-agreement.service';
import { secretIn } from './triage/triage-policy';
import { answerGaps, isAccepted } from './upkeep/gap-answers';
import {
  citedByLivePages,
  heldSince,
  reversalsFor,
  unusedSince,
} from './upkeep/maintenance';

@Injectable()
export default class PageEntriesService {
  private readonly logger = new Logger(PageEntriesService.name);

  /**
   * The indexer and the vector service are optional for the same reason the
   * indexer is on PagesService: the index is a cache. A write that finds
   * Typesense down still gets the exact-duplicate check, which is postgres.
   * The citation checker is not a cache, so a write that names citations is
   * refused rather than stored unchecked when it is absent. Without the queue
   * an entry is not triaged, and waits in the inbox for a person as before;
   * without the agreement service, what people decide about triaged entries
   * is not recorded as verdicts on triage.
   */
  constructor(
    private prisma: PrismaService,
    private indexer?: KnowledgeIndexService,
    private vectorService?: VectorService,
    private citations?: EntryCitationsService,
    @Optional() @InjectQueue(PAGES_QUEUE) private pagesQueue?: Queue,
    @Optional() private agreement?: KnowledgeAgreementService,
  ) {}

  // ----------------------------------------------------------------- reading

  async getEntries(
    workspaceId: string,
    filters: {
      pageId?: string;
      status?: PageEntryStatusEnum[];
      /** Entries resolved to any of these modules. */
      moduleIds?: string[];
      /** At most this many, newest first. */
      limit?: number;
    } = {},
  ): Promise<PageEntry[]> {
    const entries = await this.prisma.pageEntry.findMany({
      where: {
        deleted: null,
        page: { workspaceId, deleted: null },
        ...(filters.pageId ? { pageId: filters.pageId } : {}),
        ...(filters.status?.length ? { status: { in: filters.status } } : {}),
        ...(filters.moduleIds?.length
          ? { moduleIds: { hasSome: filters.moduleIds } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      ...(filters.limit ? { take: filters.limit } : {}),
      include: { citations: { select: PROOF_CITATION_SELECT } },
    });

    // Every entry read goes out with its proof, the same as a search hit, so
    // an agent reading a page is told what each claim rests on.
    return entries.map((entry) => ({
      ...entry,
      ...entryProof(entry),
    })) as unknown as PageEntry[];
  }

  // ----------------------------------------------------------------- writing

  /**
   * Appends one asserted fact to a page.
   *
   * Three mechanical gates stand in front of this, all server-side because a
   * client that ignores tool descriptions must not be able to walk past them:
   * the page's entry policy, the per-token budget on untriaged entries, and the
   * supersede pointer that stops a correction sitting beside the thing it
   * corrects.
   */
  async createEntry(
    pageId: string,
    writer: WriterIdentity,
    entryData: CreatePageEntryDto,
  ): Promise<PageEntry> {
    const page = await this.prisma.page.findFirst({
      where: { id: pageId, deleted: null },
      select: { id: true, title: true, entryPolicy: true, workspaceId: true },
    });

    if (!page) {
      throw new NotFoundException({ message: `Page ${pageId} not found` });
    }

    assertNoSecret(entryData.content);

    const isAgent = await this.isAutomated(writer.userId);

    if (page.entryPolicy === PageEntryPolicyEnum.LOCKED && isAgent) {
      throw new ForbiddenException({
        message:
          `"${page.title}" is locked: it is maintained by hand. Reads are ` +
          'unaffected — you can still recall and load context from it — but ' +
          'appending is not open to agents. Append to a related page instead, ' +
          'or ask a human to unlock this one.',
      });
    }

    if (page.entryPolicy === PageEntryPolicyEnum.CURATED) {
      await this.assertBudgetAvailable(page.id, page.title, writer);
    }

    // An agent's writes always land in the inbox. A human reviewer working in
    // the webapp is the review step, so asking for STANDING directly is not a
    // way around triage — it *is* triage.
    const status =
      entryData.standing && !isAgent
        ? PageEntryStatusEnum.STANDING
        : PageEntryStatusEnum.PROPOSED;

    let detach: string | null = null;

    if (entryData.supersedesId) {
      detach = await this.assertSupersedable(entryData.supersedesId, pageId, {
        displacePending: status === PageEntryStatusEnum.STANDING,
      });
    } else if (!entryData.distinct) {
      await this.assertNotAlreadyKnown(page, entryData, {
        // A person writing a standing fact in the webapp is the reviewer, with
        // the page open in front of them; asking them to confirm that a fact
        // merely resembling another is distinct would be asking the reviewer
        // to review themselves. An exact repeat is still refused.
        nearMatches: isAgent || !entryData.standing,
      });
    }

    // A correction takes the entry it replaces out of use only once the
    // correction itself is accepted. A person writing standing knowledge is
    // the acceptance, so theirs retires the old entry at once. Anything that
    // lands in the inbox waits there with the pointer recorded, and the entry
    // it corrects keeps being served meanwhile: a claim nobody has reviewed
    // must not be able to take accepted knowledge out of use, and SUPERSEDED
    // cannot be undone.
    const moduleIds = await this.modulesFor(page.workspaceId, entryData.scope);

    // Last of the gates, because it is the only one that reads from outside
    // the database: every citation is checked, and one that does not hold
    // refuses the write before anything is stored.
    const citations = await this.checkCitations(
      page.workspaceId,
      entryData.citations,
    );

    const retiresNow =
      Boolean(entryData.supersedesId) &&
      status === PageEntryStatusEnum.STANDING;
    const retired =
      retiresNow && entryData.supersedesId
        ? await this.chainToRetire([entryData.supersedesId])
        : [];

    const results = await this.prisma.$transaction([
      // The pointer is unique, so an earlier correction that was rejected,
      // held or displaced gives it up in the same transaction, before the new
      // one takes it. The earlier entry keeps everything else it recorded.
      ...(detach
        ? [
            this.prisma.pageEntry.update({
              where: { id: detach },
              data: { supersedesId: null },
            }),
          ]
        : []),
      this.prisma.pageEntry.create({
        data: {
          content: entryData.content,
          contentHash: contentHashOf(entryData.content),
          scope: entryData.scope ?? null,
          moduleIds,
          ...(entryData.kind && { kind: entryData.kind }),
          status,
          sourceUserId: writer.userId,
          sourceSession: entryData.sourceSession ?? null,
          sourceTokenId: writer.tokenId,
          supersedesId: entryData.supersedesId ?? null,
          pageId,
          ...(citations.length && { citations: { create: citations } }),
        },
        // Returned with its proof, so a writer sees what its citations came
        // to: held, or unread and to be retried.
        include: { citations: { select: PROOF_CITATION_SELECT } },
      }),
      // The replaced row keeps its content — the audit trail is the point — but
      // stops being served the moment its accepted replacement exists, so a
      // reader is never handed both truths and left to pick.
      ...(retired.length
        ? [
            this.prisma.pageEntry.updateMany({
              where: { id: { in: retired } },
              data: { status: PageEntryStatusEnum.SUPERSEDED },
            }),
          ]
        : []),
    ]);
    const entry = results[detach ? 1 : 0] as ProofRow & { id: string };

    // The new entry enters the index in the same breath as it is written. A
    // human writing a fact by hand *is* the review step, so it lands STANDING
    // and is served immediately — without this it would sit unsearchable until
    // some later, unrelated write happened to touch it.
    await this.indexer?.entryChanged(entry.id);

    // A superseded entry has to leave the index in the same breath, or the
    // reader gets both the correction and the thing it corrected and has no
    // way to tell which is current.
    await this.indexer?.entriesChanged(retired);

    // Citations the repository did not answer for are read again later; until
    // then the entry is written, and simply not grounded.
    await this.citations?.retryLater(entry.id, citations);

    if (status === PageEntryStatusEnum.PROPOSED) {
      await this.triageLater(entry.id);
    } else if (
      citations.some(
        (citation) => citation.kind === PageEntryCitationKindEnum.ISSUE,
      )
    ) {
      await this.answerGapsQuietly([entry.id]);
    }

    return { ...entry, ...entryProof(entry) } as unknown as PageEntry;
  }

  /**
   * Queues the triage of a new entry in the inbox. The write has happened
   * whether or not the queue takes it: an entry that is not triaged waits
   * for a person, which is where every entry waited before triage existed.
   */
  private async triageLater(entryId: string): Promise<void> {
    try {
      await this.pagesQueue?.add(
        TRIAGE_ENTRY_JOB,
        { entryId },
        triageEntryJobOptions(entryId),
      );
    } catch (error) {
      this.logger.warn(
        `Could not queue triage for entry ${entryId}: ${error}; it waits for a person`,
      );
    }
  }

  /**
   * Marks answered the knowledge gaps these newly accepted entries answer, by
   * citing the issue opened for them. Best effort: the acceptance stands
   * either way, and the gap job marks any this misses on its next run.
   */
  private async answerGapsQuietly(entryIds: string[]): Promise<void> {
    try {
      await answerGaps(this.prisma, entryIds);
    } catch (error) {
      this.logger.warn(
        `Could not mark the knowledge gaps answered by ${entryIds.join(', ')}: ${error}; the gap job will`,
      );
    }
  }

  private async checkCitations(
    workspaceId: string,
    inputs: CreatePageEntryDto['citations'],
  ): Promise<CitationDraft[]> {
    if (!inputs?.length) {
      return [];
    }

    if (!this.citations) {
      throw new Error('Citations cannot be checked: no checker is configured');
    }

    return this.citations.checkForWrite(workspaceId, inputs);
  }

  /**
   * `audit` names a decision drawn for audit that this change answers: the
   * change then lands only with that decision's verdict, and is refused when
   * someone else's verdict landed first.
   */
  async updateEntry(
    entryId: string,
    userId: string,
    entryData: UpdatePageEntryDto,
    options: { audit?: string; proposal?: string } = {},
  ): Promise<PageEntry> {
    const current = await this.prisma.pageEntry.findFirst({
      where: { id: entryId, deleted: null },
      select: {
        status: true,
        content: true,
        scope: true,
        kind: true,
        sourceUserId: true,
        supersedesId: true,
        supersedes: { select: { status: true } },
        page: { select: { workspaceId: true } },
      },
    });

    if (!current) {
      throw new NotFoundException({ message: `Entry ${entryId} not found` });
    }

    const agent = await this.isAutomated(userId);

    if (agent) {
      this.assertAgentMayEdit(current, userId, entryData);
    }

    if (entryData.content !== undefined) {
      assertNoSecret(entryData.content);
    }

    if (entryData.status !== undefined) {
      this.assertTransitionAllowed(
        current.status as PageEntryStatusEnum,
        entryData.status,
      );
    }

    // Named field by field for the same reason page updates are: the global
    // ValidationPipe does not whitelist, so a stray `pageId` would move an
    // asserted fact onto a page in another workspace and `retrievalCount` would
    // let a caller fake demonstrated usefulness.
    const settled =
      entryData.status !== undefined && entryData.status !== current.status
        ? await this.settleCorrections(
            [{ id: entryId, ...current }],
            entryData.status,
          )
        : { operations: [], retired: [] };

    // A person acting on an entry triage sent them gives triage a verdict,
    // written with the change. An agent withdrawing or rewording its own
    // entry is not a verdict on anything.
    const verdicts =
      agent || !this.agreement
        ? { operations: [], decisionIds: [], workspaceIds: [] }
        : await this.agreement.verdictsFor(
            [{ id: entryId, status: current.status }],
            {
              status: entryData.status,
              edited:
                (entryData.content !== undefined &&
                  entryData.content !== current.content) ||
                (entryData.scope !== undefined &&
                  entryData.scope !== current.scope) ||
                (entryData.kind !== undefined &&
                  entryData.kind !== current.kind),
            },
            userId,
            { strict: options.audit },
          );

    if (options.audit && !verdicts.decisionIds.includes(options.audit)) {
      throw new ConflictException({
        message:
          'This audit can no longer be answered: it has a verdict, or a later decision replaced it.',
      });
    }

    // A person putting back what the gardener took out of use undoes it, and
    // says so on the record the gardener reads before acting again.
    const reversals =
      agent || entryData.status === undefined
        ? []
        : reversalsFor(
            this.prisma,
            [{ id: entryId, status: current.status }],
            entryData.status,
            userId,
          );
    // A proposal answered by this change is resolved with it, and only while
    // it is still open: of two people answering at once, the second's change
    // fails with its answer.
    const proposal = options.proposal
      ? [
          this.prisma.pageEntryMaintenance.update({
            where: {
              id: options.proposal,
              entryId,
              proposalState: PageEntryProposalState.OPEN,
            },
            data: {
              proposalState: PageEntryProposalState.ACCEPTED,
              resolvedById: userId,
              resolvedAt: new Date(),
            },
          }),
        ]
      : [];

    const [entry] = await this.prisma.$transaction([
      this.prisma.pageEntry.update({
        where: { id: entryId },
        data: {
          ...(entryData.content !== undefined && {
            content: entryData.content,
            contentHash: contentHashOf(entryData.content),
          }),
          ...(entryData.scope !== undefined && {
            scope: entryData.scope,
            moduleIds: await this.modulesFor(
              current.page.workspaceId,
              entryData.scope,
            ),
          }),
          ...(entryData.kind !== undefined && { kind: entryData.kind }),
          ...(entryData.status !== undefined && { status: entryData.status }),
          ...(entryData.verified !== undefined && {
            verifiedByUserId: entryData.verified ? userId : null,
            verifiedAt: entryData.verified ? new Date() : null,
          }),
        },
        include: { citations: { select: PROOF_CITATION_SELECT } },
      }),
      ...settled.operations,
      ...verdicts.operations,
      ...reversals,
      ...proposal,
    ]);
    await this.indexer?.entryChanged(entryId);
    await this.indexer?.entriesChanged(settled.retired);
    await this.agreement?.reevaluateQuietly(verdicts.workspaceIds);

    if (
      entryData.status !== undefined &&
      entryData.status !== current.status &&
      isAccepted(entryData.status)
    ) {
      await this.answerGapsQuietly([entryId]);
    }

    return {
      ...entry,
      ...entryProof(entry as unknown as ProofRow),
    } as unknown as PageEntry;
  }

  /**
   * Applies one decision to a set of entries — the write half of facet-first
   * triage. Entries whose current status forbids the transition are skipped
   * rather than failing the batch, so one terminal row in a selection of forty
   * does not send the reviewer back to picking rows off one at a time.
   */
  async bulkUpdate(
    workspaceId: string,
    userId: string,
    input: BulkUpdatePageEntriesDto,
  ): Promise<{ updated: number; skipped: number }> {
    // Every bulk request is a triage decision — it only sets a status — and
    // triage is the review step an agent's writes wait for. An agent able to
    // make it would be its own reviewer.
    if (await this.isAutomated(userId)) {
      throw new ForbiddenException({
        message:
          'Triage is for people: accepting, disputing or archiving entries in ' +
          'bulk decides what the workspace believes, and an agent cannot make ' +
          'that decision about knowledge. Nothing was changed. To withdraw ' +
          'one of your own untriaged entries, archive it on its own.',
      });
    }

    const entries = await this.prisma.pageEntry.findMany({
      where: {
        id: { in: input.entryIds },
        deleted: null,
        page: { workspaceId, deleted: null },
      },
      select: {
        id: true,
        status: true,
        supersedesId: true,
        supersedes: { select: { status: true } },
      },
    });

    const eligibleEntries = entries.filter((entry) =>
      ALLOWED_STATUS_TRANSITIONS[entry.status as PageEntryStatusEnum].includes(
        input.status,
      ),
    );
    const eligible = eligibleEntries.map((entry) => entry.id);

    if (eligible.length > 0) {
      const settled = await this.settleCorrections(
        eligibleEntries,
        input.status,
      );
      const verdicts = this.agreement
        ? await this.agreement.verdictsFor(
            eligibleEntries,
            { status: input.status, edited: false },
            userId,
          )
        : { operations: [], decisionIds: [], workspaceIds: [] };

      await this.prisma.$transaction([
        this.prisma.pageEntry.updateMany({
          where: { id: { in: eligible } },
          data: { status: input.status },
        }),
        ...settled.operations,
        ...verdicts.operations,
        ...reversalsFor(this.prisma, eligibleEntries, input.status, userId),
      ]);
      await this.indexer?.entriesChanged([...eligible, ...settled.retired]);
      await this.agreement?.reevaluateQuietly(verdicts.workspaceIds);

      if (isAccepted(input.status)) {
        await this.answerGapsQuietly(eligible);
      }
    }

    return {
      updated: eligible.length,
      skipped: input.entryIds.length - eligible.length,
    };
  }

  // ------------------------------------------------------ scope and modules

  /**
   * Resolves every entry's scope against the modules as they stand now, and
   * writes the ones that moved.
   *
   * An entry's modules are fixed when it is written, but the modules are not:
   * a repository is added, a prefix is narrowed, a module is deleted. Run when
   * any of that happens to a workspace, and once at boot for all of them, which
   * also fills in entries written before modules were resolved at all.
   * Idempotent: an entry whose modules did not move is not written, so a
   * second run changes nothing and re-indexes nothing.
   */
  async recomputeModules(workspaceId?: string): Promise<{ changed: number }> {
    const workspaceIds = workspaceId
      ? [workspaceId]
      : (
          await this.prisma.page.findMany({
            where: { deleted: null },
            select: { workspaceId: true },
            distinct: ['workspaceId'],
          })
        ).map((page) => page.workspaceId);

    let changed = 0;

    for (const id of workspaceIds) {
      const mappings = await this.moduleMappings(id);
      const entries = await this.prisma.pageEntry.findMany({
        where: { deleted: null, page: { workspaceId: id, deleted: null } },
        select: { id: true, scope: true, moduleIds: true },
      });

      const moved = entries
        .map((entry) => ({
          id: entry.id,
          before: entry.moduleIds ?? [],
          after: modulesForScope(mappings, entry.scope),
        }))
        .filter(({ before, after }) => !sameMembers(before, after));

      for (const { id: entryId, after } of moved) {
        await this.prisma.pageEntry.update({
          where: { id: entryId },
          data: { moduleIds: after },
        });
      }

      await this.indexer?.entriesChanged(
        moved.map(({ id: entryId }) => entryId),
      );
      changed += moved.length;
    }

    return { changed };
  }

  // ------------------------------------------------------- serving and decay

  /**
   * Records that entries were actually served, and to whom.
   *
   * `increment` compiles to `SET "retrievalCount" = "retrievalCount" + 1`, so
   * two searches landing on the same entry at the same moment both count —
   * a read-then-write would lose one, and this number decides what survives
   * the decay pass.
   *
   * A use row per entry goes in with one insert, so a recall of twenty hits
   * is one statement, not twenty. The counters and the rows are written
   * together or not at all: a use nobody counted, or a count nobody can
   * attribute, would make the two disagree about how often an entry is read.
   */
  async recordServed(entryIds: string[], to: ServedTo): Promise<void> {
    const ids = [...new Set(entryIds)];

    if (ids.length === 0) {
      return;
    }

    await this.prisma.$transaction([
      this.prisma.pageEntry.updateMany({
        where: { id: { in: ids } },
        data: { retrievalCount: { increment: 1 }, lastServedAt: new Date() },
      }),
      this.prisma.pageEntryUse.createMany({
        data: ids.map((entryId) => ({
          entryId,
          workspaceId: to.workspaceId,
          via: to.via,
          agentRunId: to.agentRunId ?? null,
          sessionId: to.sessionId ?? null,
          tokenId: to.tokenId ?? null,
          userId: to.userId ?? null,
        })),
      }),
    ]);
  }

  /**
   * Ages out knowledge nobody is using, in the two ways it goes stale.
   *
   * An untriaged entry that has sat in the inbox past the window archives
   * itself: an unbounded inbox is what actually overwhelms a person, and a
   * reviewer who opens a rail of four hundred rows closes it again.
   *
   * A standing entry nothing has retrieved within a longer window archives on
   * that window, because unused knowledge is by definition not load-bearing.
   * The window is measured from the last time the entry was served, not from
   * whether it was ever served: an entry read once in its first week and never
   * again is as unused as one nobody read, and one read yesterday is not.
   * Nothing is deleted either way — archived entries stay readable and can be
   * revived.
   *
   * Either way, an entry a check found to hold within the window stays: its
   * citations were read against the code and still support it, which says it
   * is true whether or not anyone asked. And an entry a person verified is
   * never archived by decay: the gardener asks a person instead
   * (`KnowledgeUpkeepService.proposeUnused`), and an untriaged one is already
   * waiting on a person. Outcomes do not archive either: a harmful signal
   * re-checks the entry's citations, and what that check finds is what
   * counts. Nor is an entry a live page cites archived: the page is read in
   * its place, and the entry is the page's evidence.
   *
   * Called nightly by `PagesProcessor` on the `pages` queue, on the schedule in
   * `DECAY_CRON`. Setting `PAGE_DECAY_CRON=off` disables the pass, which leaves
   * both windows dormant and the inbox bounded only by the per-token budget on
   * curated pages — worth knowing before turning it off.
   */
  async runDecay(workspaceId?: string): Promise<{
    expiredProposed: number;
    archivedStanding: number;
  }> {
    const scope: Prisma.PageEntryWhereInput = workspaceId
      ? { page: { workspaceId, deleted: null } }
      : { page: { deleted: null } };

    const proposedCutoff = daysAgo(PROPOSED_ENTRY_EXPIRY_DAYS);
    const standingCutoff = daysAgo(STANDING_ENTRY_DECAY_DAYS);

    const expiredProposed = await this.prisma.pageEntry.updateMany({
      where: {
        ...scope,
        deleted: null,
        status: PageEntryStatusEnum.PROPOSED,
        createdAt: { lt: proposedCutoff },
        citations: { none: heldSince(proposedCutoff) },
        verifiedAt: null,
      },
      data: { status: PageEntryStatusEnum.ARCHIVED },
    });

    const cited = await citedByLivePages(this.prisma, workspaceId);
    const archivedStanding = await this.prisma.pageEntry.updateMany({
      where: {
        ...scope,
        deleted: null,
        status: PageEntryStatusEnum.STANDING,
        ...unusedSince(standingCutoff),
        ...(cited.length ? { id: { notIn: cited } } : {}),
        // A human vouched for it. Demonstrated usefulness is a proxy for
        // "worth keeping"; an explicit human confirmation is the real thing,
        // and it outranks the proxy.
        verifiedAt: null,
      },
      data: { status: PageEntryStatusEnum.ARCHIVED },
    });

    return {
      expiredProposed: expiredProposed.count,
      archivedStanding: archivedStanding.count,
    };
  }

  // --------------------------------------------------------------- internals

  /** The modules a scope falls in, against this workspace's repositories. */
  private async modulesFor(
    workspaceId: string,
    scope: string | null | undefined,
  ): Promise<string[]> {
    if (!scope) {
      return [];
    }

    return modulesForScope(await this.moduleMappings(workspaceId), scope);
  }

  private async moduleMappings(workspaceId: string) {
    return this.prisma.moduleRepo.findMany({
      where: { deleted: null, module: { workspaceId, deleted: null } },
      select: { moduleId: true, pathPrefixes: true, fullName: true },
    });
  }

  /**
   * Refuses an append once a token is holding too many untriaged entries on one
   * curated page, and says what to do about it.
   *
   * The refusal names the entries in the way of the write, because a dead end
   * teaches an agent nothing and it will simply try the same append again. This
   * is the same posture `assertSubstantialIssue` takes for thin issues: the
   * error is the instruction.
   */
  private async assertBudgetAvailable(
    pageId: string,
    pageTitle: string,
    writer: WriterIdentity,
  ): Promise<void> {
    // A browser session carries no token, so the account stands in for one.
    // Falling back to no key at all would count every caller's writes together
    // and let one agent exhaust everybody's allowance.
    const budgetKey: Prisma.PageEntryWhereInput = writer.tokenId
      ? { sourceTokenId: writer.tokenId }
      : { sourceTokenId: null, sourceUserId: writer.userId };

    const outstanding = await this.prisma.pageEntry.findMany({
      where: {
        pageId,
        deleted: null,
        status: PageEntryStatusEnum.PROPOSED,
        ...budgetKey,
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, content: true },
    });

    if (outstanding.length < PROPOSED_ENTRY_BUDGET) {
      return;
    }

    const listed = outstanding
      .slice(0, PROPOSED_ENTRY_BUDGET)
      .map((entry) => `- ${entry.id}: ${firstLine(entry.content)}`)
      .join('\n');

    throw new ForbiddenException({
      message:
        `You already have ${outstanding.length} untriaged entries on ` +
        `"${pageTitle}", which is the limit for one token on a curated page. ` +
        'Nothing was created. Consolidate what is there or supersede the entry ' +
        'this one replaces, then append again. Outstanding:\n' +
        `${listed}`,
    });
  }

  /**
   * What accepting corrections does to the entries they correct.
   *
   * Accepting a correction (STANDING, or CONSOLIDATED into the body) is the
   * moment it replaces its target, so the target becomes SUPERSEDED then and
   * not when the correction was written. Rejecting or holding one (ARCHIVED,
   * DISPUTED) changes nothing: the target stays in use, and the pointer stays
   * too, because both states can be revived — a disputed correction accepted
   * later still replaces what it corrected. A new correction of the same
   * entry takes the pointer over only from an archived one, or from a person
   * writing standing knowledge (see `assertSupersedable`).
   *
   * Returns the writes for the caller's transaction, and the ids that leave
   * the index.
   */
  private async settleCorrections(
    entries: Array<{
      id: string;
      supersedesId: string | null;
      supersedes: { status: string } | null;
    }>,
    to: PageEntryStatusEnum,
  ): Promise<{
    operations: Prisma.PrismaPromise<unknown>[];
    retired: string[];
  }> {
    if (
      to !== PageEntryStatusEnum.STANDING &&
      to !== PageEntryStatusEnum.CONSOLIDATED
    ) {
      return { operations: [], retired: [] };
    }

    const targets = entries
      .filter(
        (entry) =>
          entry.supersedesId &&
          entry.supersedes &&
          !isDecided(entry.supersedes.status),
      )
      .map((entry) => entry.supersedesId as string);

    const retired = await this.chainToRetire(targets);

    if (retired.length === 0) {
      return { operations: [], retired: [] };
    }

    return {
      operations: [
        this.prisma.pageEntry.updateMany({
          where: { id: { in: retired } },
          data: { status: PageEntryStatusEnum.SUPERSEDED },
        }),
      ],
      retired,
    };
  }

  /**
   * The entries an accepted correction retires: its target, and, when that
   * target was itself a correction nobody accepted, what it was correcting,
   * back along the chain.
   *
   * A chain forms naturally. An agent's correction is refused as a near match
   * of the correction already waiting, so it resends superseding that one; a
   * person accepting the latest link has accepted a replacement for the
   * original, and leaving the original in use would serve both truths. The
   * walk passes only through corrections still undecided (PROPOSED or
   * DISPUTED), and never touches anything already replaced (SUPERSEDED). A
   * consolidated entry is retired like a standing one: it is served as its
   * page's evidence, and the correction is what is served from then on.
   * Pointers are set only when an entry is written and always name an older
   * entry, so the chain cannot loop; the visited set is belt and braces.
   */
  private async chainToRetire(startIds: string[]): Promise<string[]> {
    const retire = new Set<string>();
    let frontier = startIds;

    while (frontier.length > 0) {
      const rows = await this.prisma.pageEntry.findMany({
        where: { id: { in: frontier }, deleted: null },
        select: { id: true, status: true, supersedesId: true },
      });

      frontier = [];
      for (const row of rows) {
        if (isDecided(row.status) || retire.has(row.id)) {
          continue;
        }
        retire.add(row.id);
        // Only an undecided correction carries its claim on to what it
        // corrects. An archived one was rejected by a person, withdrawn by its
        // writer or left to expire; either way it is not a replacement anyone
        // accepted, and accepting a correction of it must not quietly retire
        // what it had meant to replace.
        if (
          row.supersedesId &&
          !retire.has(row.supersedesId) &&
          (row.status === PageEntryStatusEnum.PROPOSED ||
            row.status === PageEntryStatusEnum.DISPUTED)
        ) {
          frontier.push(row.supersedesId);
        }
      }
    }

    return [...retire];
  }

  /**
   * What an agent may change on an entry: the wording, scope or withdrawal of
   * its own claim while it still waits in the inbox, and nothing else.
   *
   * Promoting, disputing and verifying are triage, which is the review an
   * agent's writes wait for; an agent able to make those calls would be its
   * own reviewer. Editing an entry somebody already accepted is the same thing
   * by another route — the text would change under a decision made about
   * different text — so a correction to standing knowledge is a new entry that
   * supersedes it. That lands in the inbox like any other claim, and the entry
   * it corrects stays in use until a person accepts it.
   */
  private assertAgentMayEdit(
    current: { status: string; sourceUserId: string | null },
    userId: string,
    entryData: UpdatePageEntryDto,
  ): void {
    if (entryData.verified !== undefined) {
      throw new ForbiddenException({
        message:
          'Only a person can verify an entry: verification is a human saying ' +
          'the claim is true, and it outranks everything else the bank knows ' +
          'about it. Nothing was changed.',
      });
    }

    const statusChange =
      entryData.status !== undefined && entryData.status !== current.status
        ? entryData.status
        : undefined;

    if (statusChange && statusChange !== PageEntryStatusEnum.ARCHIVED) {
      throw new ForbiddenException({
        message:
          `An agent cannot move an entry to ${statusChange}: deciding whether ` +
          'a fact stands is triage, and triage is for people. Nothing was ' +
          'changed. You can archive one of your own untriaged entries to ' +
          'withdraw it.',
      });
    }

    if (current.sourceUserId !== userId) {
      throw new ForbiddenException({
        message:
          'This entry was written by someone else. An agent may only edit or ' +
          'withdraw its own entries. To correct it, write a new entry that ' +
          'supersedes it. Nothing was changed.',
      });
    }

    if (current.status !== PageEntryStatusEnum.PROPOSED) {
      throw new ForbiddenException({
        message:
          `This entry is already ${current.status}, so the workspace has ` +
          'decided about it. To correct it, write a new entry that supersedes ' +
          'it. Nothing was changed.',
      });
    }
  }

  /**
   * Refuses a write the page already holds, and hands back what it holds.
   *
   * Rediscovering the same fact is the flood this bank exists to prevent: ten
   * well-behaved agents each appending the same six facts. The check lives
   * here, under every client, because a check in one client is skipped by
   * every other — the REST API, the CLI and a harness calling the endpoint
   * directly all arrive here.
   *
   * Two tiers, both skipped when the writer names an entry to supersede or
   * says the fact is distinct. An exact repeat, after normalising case and
   * whitespace, is found in postgres and refused for every writer. A near
   * match is found by
   * the hybrid search `findSimilarEntries` runs, and is best effort: with the
   * index unreachable the write goes ahead on the exact check alone, because a
   * cache being down is not a reason to stop recording knowledge.
   */
  private async assertNotAlreadyKnown(
    page: { id: string; title: string; workspaceId: string },
    entryData: CreatePageEntryDto,
    options: { nearMatches: boolean },
  ): Promise<void> {
    const normalised = normaliseContent(entryData.content);

    const candidates = await this.prisma.pageEntry.findMany({
      where: {
        pageId: page.id,
        deleted: null,
        // Consolidated too: it is still served, as the page's evidence.
        status: {
          in: [
            PageEntryStatusEnum.PROPOSED,
            PageEntryStatusEnum.STANDING,
            PageEntryStatusEnum.CONSOLIDATED,
          ],
        },
      },
      select: {
        id: true,
        content: true,
        scope: true,
        status: true,
        sourceUserId: true,
        verifiedAt: true,
        retrievalCount: true,
        citations: { select: PROOF_CITATION_SELECT },
      },
    });

    const matches: KnowledgeSearchHit[] = candidates
      .filter((entry) => normaliseContent(entry.content) === normalised)
      .map((entry) => ({
        id: entry.id,
        kind: 'entry',
        pageId: page.id,
        pageTitle: page.title,
        entryId: entry.id,
        title: page.title,
        content: entry.content,
        scope: entry.scope,
        status: entry.status,
        sourceUserId: entry.sourceUserId,
        verified: entry.verifiedAt !== null,
        retrievalCount: entry.retrievalCount,
        ...entryProof(entry),
      }));

    if (options.nearMatches && this.vectorService) {
      try {
        const near = await this.vectorService.findSimilarEntries(
          page.workspaceId,
          page.id,
          entryData.content,
        );
        const known = new Set(matches.map((match) => match.entryId));
        matches.push(...near.filter((hit) => !known.has(hit.entryId)));
      } catch (error) {
        this.logger.warn(
          `Near-match check skipped for page ${page.id}: ` +
            `${(error as Error).message}`,
        );
      }
    }

    if (matches.length === 0) {
      return;
    }

    // The first sentence is for whoever reads it in the webapp, where the
    // useful act is usually to accept the entry that is already there; the
    // second is for a client that can resend.
    const [first] = matches;
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      status: 'needs-decision',
      message:
        `"${page.title}" already has this: "${firstLine(first.content)}" ` +
        `(${first.status.toLowerCase()}` +
        `${matches.length > 1 ? `, and ${matches.length - 1} more like it` : ''}` +
        '). Nothing was written. To write it anyway, resend with ' +
        '`supersedesId` set to the entry it replaces, or `distinct: true` if ' +
        'it is a separate fact.',
      nearMatches: matches,
    });
  }

  /**
   * Checks a correction may be written, and says which earlier correction of
   * the same entry has to give up its pointer first, if any.
   *
   * An entry already replaced cannot be replaced again: correct its
   * replacement instead. An entry with a correction still waiting for review
   * cannot take a second one, or two claims would race to replace it — except
   * from a person writing standing knowledge, who is the review, and whose
   * correction displaces the waiting one; that one stays where it is as an
   * ordinary claim. A correction held in dispute counts as waiting. One that
   * was rejected (archived) gives way to a new one. An entry already folded
   * into the page body is corrected in the body.
   */
  private async assertSupersedable(
    supersedesId: string,
    pageId: string,
    options: { displacePending: boolean },
  ): Promise<string | null> {
    const target = await this.prisma.pageEntry.findFirst({
      where: { id: supersedesId, deleted: null, pageId },
      select: {
        status: true,
        supersededBy: { select: { id: true, status: true } },
      },
    });

    if (!target) {
      throw new NotFoundException({
        message: `Entry ${supersedesId} is not on this page`,
      });
    }

    if (target.status === PageEntryStatusEnum.SUPERSEDED) {
      throw new BadRequestException({
        message:
          `Entry ${supersedesId} has already been superseded` +
          (target.supersededBy ? ` by ${target.supersededBy.id}` : '') +
          '. Supersede that one instead — a fact with two replacements is a ' +
          'contradiction, not a correction.',
      });
    }

    if (!target.supersededBy) {
      return null;
    }

    // A disputed correction is held, not rejected: it can still be accepted,
    // and giving its pointer away now would let that later acceptance serve
    // beside the entry it corrects.
    const undecided =
      target.supersededBy.status === PageEntryStatusEnum.PROPOSED ||
      target.supersededBy.status === PageEntryStatusEnum.DISPUTED;

    if (undecided && !options.displacePending) {
      throw new BadRequestException({
        message:
          `A correction to entry ${supersedesId} is already waiting for ` +
          `review: ${target.supersededBy.id}. Nothing was written. Until a ` +
          'person accepts or rejects it, the entry cannot take a second one. ' +
          'If yours refines it, supersede that correction instead.',
      });
    }

    return target.supersededBy.id;
  }

  private assertTransitionAllowed(
    from: PageEntryStatusEnum,
    to: PageEntryStatusEnum,
  ): void {
    if (from === to) {
      return;
    }

    if (!ALLOWED_STATUS_TRANSITIONS[from].includes(to)) {
      throw new BadRequestException({
        message:
          `An entry cannot go from ${from} to ${to}. ` +
          (ALLOWED_STATUS_TRANSITIONS[from].length === 0
            ? `${from} is terminal: the workspace has already decided about ` +
              'this fact, and reviving it would put it back into circulation.'
            : `From ${from} the options are ` +
              `${ALLOWED_STATUS_TRANSITIONS[from].join(', ')}.`),
      });
    }
  }

  /**
   * Whether a writer is automated: an agent, or a system bot such as the
   * knowledge gardener. Neither is a person, so both are held to what an
   * agent is: no writing to a locked page, no entry straight into use, and
   * no decision that stands for a person's.
   */
  private async isAutomated(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { type: true },
    });

    return (
      user?.type === UserTypeEnum.Agent || user?.type === UserTypeEnum.System
    );
  }
}

/** Whether two id lists hold the same ids, in any order. */
function sameMembers(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/**
 * A status the workspace has finished deciding about: replaced already.
 * Nothing moves an entry out of it, so a correction never touches one.
 */
function isDecided(status: string): boolean {
  return status === PageEntryStatusEnum.SUPERSEDED;
}

/**
 * The form two entries are compared in. Case and runs of whitespace are how
 * the same sentence differs between two sessions that learned it; anything
 * more is a different sentence, and deciding whether it is a different fact
 * is the near-match check's job.
 */
export function normaliseContent(content: string): string {
  return content.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The hash exact repeats are found by: sha256 of the normalised content. The
 * migration that added it computes the same for existing entries in SQL.
 */
export function contentHashOf(content: string): string {
  return createHash('sha256').update(normaliseContent(content)).digest('hex');
}

/**
 * Refuses content that looks like it holds a credential, before anything is
 * stored. Entries are replicated to every member's browser and handed to
 * agents, so a key written into one has been shared with all of them; a
 * refusal at the door is the only point at which that can still be stopped.
 * Said without echoing the content back, so the refusal does not repeat it.
 */
function assertNoSecret(content: string): void {
  const secret = secretIn(content);

  if (secret) {
    throw new UnprocessableEntityException({
      status: 'secret-refused',
      message:
        `Nothing was written: the content looks like it holds a ${secret}. ` +
        'Knowledge is shared with every member and every agent of the ' +
        'workspace, so credentials never belong in it. Describe where the ' +
        'secret is kept and how it is used instead of writing it down.',
    });
  }
}

function firstLine(content: string): string {
  const line = content.trim().split('\n')[0];
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
