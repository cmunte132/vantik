import { InjectQueue } from '@nestjs/bull';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ConsolidatePageDto,
  CreatePageDto,
  Page,
  PageEntryStatusEnum,
  PageKindEnum,
  type PageProposal,
  PageProposalStateEnum,
  UpdatePageDto,
  UserTypeEnum,
} from '@vantikhq/types';
import { Queue } from 'bull';
import { PrismaService } from 'nestjs-prisma';

import {
  convertMarkdownToTiptapJson,
  convertTiptapJsonToMarkdown,
} from 'common/utils/tiptap.utils';

import { citedBy, readSections } from './generated/sections';
import KnowledgeIndexService from './knowledge-index.service';
import {
  PAGES_QUEUE,
  REFRESH_PAGE_JOB,
  refreshPageJobOptions,
} from './pages.interface';
import KnowledgeAgreementService from './triage/knowledge-agreement.service';

/** The longest question a generated page may answer. */
const MAX_QUESTION_LENGTH = 500;

/**
 * A generated page's question, trimmed, or a refusal. A generated page with
 * no question has nothing to gather its evidence for.
 */
function questionOf(question: string | undefined): string {
  const trimmed = question?.trim() ?? '';

  if (!trimmed) {
    throw new BadRequestException({
      message:
        'A generated page needs a question: it is what the page answers, and ' +
        'what its evidence is gathered for.',
    });
  }

  if (trimmed.length > MAX_QUESTION_LENGTH) {
    throw new BadRequestException({
      message: `A page's question is at most ${MAX_QUESTION_LENGTH} characters.`,
    });
  }

  return trimmed;
}

/**
 * The body to store, from whichever form the caller sent.
 *
 * Markdown is the boundary every non-browser caller uses. The webapp sends
 * tiptap JSON straight through, because its editor already holds that format
 * and round-tripping through markdown to satisfy the API would silently drop
 * whatever markdown cannot express.
 */
function toStoredBody(pageData: {
  description?: string;
  descriptionMarkdown?: string;
}): string | undefined {
  if (pageData.description !== undefined) {
    return pageData.description;
  }

  if (pageData.descriptionMarkdown !== undefined) {
    return JSON.stringify(
      convertMarkdownToTiptapJson(pageData.descriptionMarkdown),
    );
  }

  return undefined;
}

/** A page as the API hands it back: storage shape plus the markdown boundary. */
export type PageResponse = Page & { descriptionMarkdown: string };

export const PROPOSAL_SELECT = {
  id: true,
  createdAt: true,
  pageId: true,
  page: { select: { title: true } },
  body: true,
  entryIds: true,
  proposedById: true,
  state: true,
  decidedById: true,
  decidedAt: true,
} as const;

/** A proposal as the API returns it: its body as markdown. */
export function proposalResponse(
  row: Prisma.PageProposalGetPayload<{ select: typeof PROPOSAL_SELECT }>,
): PageProposal {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    pageId: row.pageId,
    pageTitle: row.page.title,
    bodyMarkdown: convertTiptapJsonToMarkdown(row.body),
    entryIds: row.entryIds,
    proposedById: row.proposedById,
    state: row.state as PageProposalStateEnum,
    decidedById: row.decidedById,
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

/** Everything on a page except its body — see `getPages`. */
const SUMMARY_FIELDS = {
  id: true,
  createdAt: true,
  updatedAt: true,
  deleted: true,
  title: true,
  parentId: true,
  sortOrder: true,
  entryPolicy: true,
  visibility: true,
  kind: true,
  question: true,
  workspaceId: true,
  createdById: true,
  updatedById: true,
} as const;

/**
 * One recorded change to a page.
 *
 * `previousBodyMarkdown` is what the body said *before* this change, and is
 * null when the change did not touch the body — a rename, a move, a policy
 * switch. Diffing is left to the reader: the server has no view on how a
 * difference should be presented, and the webapp and a CLI want different ones.
 */
export interface PageRevision {
  id: string;
  pageId: string;
  userId: string | null;
  createdAt: string;
  changes: Record<string, unknown>;
  previousBodyMarkdown: string | null;
}

@Injectable()
export default class PagesService {
  /**
   * `indexer` is optional so unit tests can construct the service with a prisma
   * double alone. Indexing is a cache update, not part of the write — see
   * KnowledgeIndexService.
   */
  constructor(
    private prisma: PrismaService,
    private indexer?: KnowledgeIndexService,
    private agreement?: KnowledgeAgreementService,
    @Optional() @InjectQueue(PAGES_QUEUE) private pagesQueue?: Queue,
  ) {}

  // ----------------------------------------------------------------- reading

  /**
   * `summary` leaves the bodies out.
   *
   * Resolving a page by title is the commonest reason anything reads this list,
   * and answering that with every document in the workspace — each converted
   * from tiptap JSON to markdown on the way out — costs the whole bank to learn
   * one uuid. Summary rows carry a null body and an empty markdown rendering,
   * so nothing mistakes an omitted body for an empty page.
   */
  async getPages(
    workspaceId: string,
    parentId?: string,
    { summary = false }: { summary?: boolean } = {},
  ): Promise<PageResponse[]> {
    const pages = await this.prisma.page.findMany({
      where: {
        workspaceId,
        deleted: null,
        ...(parentId ? { parentId } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      ...(summary ? { select: SUMMARY_FIELDS } : {}),
    });

    return pages.map((page) =>
      summary
        ? ({
            ...page,
            description: null,
            descriptionMarkdown: '',
            sections: null,
          } as PageResponse)
        : this.withMarkdown(page),
    );
  }

  async getPage(pageId: string): Promise<PageResponse> {
    const page = await this.prisma.page.findFirst({
      where: { id: pageId, deleted: null },
    });

    if (!page) {
      throw new NotFoundException({ message: `Page ${pageId} not found` });
    }

    return this.withMarkdown(page);
  }

  /** A page's ancestors, root first — the breadcrumb the page view renders. */
  async getAncestors(
    pageId: string,
  ): Promise<Array<Pick<Page, 'id' | 'title'>>> {
    const ancestors: Array<{ id: string; title: string }> = [];

    let cursor = await this.prisma.page.findFirst({
      where: { id: pageId, deleted: null },
      select: { parentId: true },
    });

    // The reparent guard below keeps the tree acyclic, but a cycle written
    // directly into the database would hang this loop, so the walk is bounded
    // by the number of pages it could legitimately visit.
    const seen = new Set<string>([pageId]);

    while (cursor?.parentId && !seen.has(cursor.parentId)) {
      const parent = await this.prisma.page.findFirst({
        where: { id: cursor.parentId, deleted: null },
        select: { id: true, title: true, parentId: true },
      });

      if (!parent) {
        break;
      }

      seen.add(parent.id);
      ancestors.unshift({ id: parent.id, title: parent.title });
      cursor = { parentId: parent.parentId };
    }

    return ancestors;
  }

  /**
   * Issues that reference this page.
   *
   * Matched on the page's own URL appearing in an issue description, rather
   * than on a join table. A link is how someone actually references a page —
   * they paste it — and asking them to also register the relationship in a
   * second place is how the two drift apart. The page id is a uuid, so the
   * substring cannot collide with prose.
   *
   * The point of showing these is that documentation and work should not be
   * two disconnected worlds: a runbook nobody links to from an issue is one
   * nobody reads when it matters.
   */
  async getBacklinks(
    pageId: string,
    workspaceId: string,
  ): Promise<
    Array<{ id: string; title: string; number: number; teamId: string }>
  > {
    const issues = await this.prisma.issue.findMany({
      where: {
        deleted: null,
        team: { workspaceId },
        description: { contains: pageId },
      },
      select: { id: true, title: true, number: true, teamId: true },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });

    return issues;
  }

  // ----------------------------------------------------------------- writing

  async createPage(
    workspaceId: string,
    userId: string,
    pageData: CreatePageDto,
  ): Promise<PageResponse> {
    if (pageData.parentId) {
      await this.assertSameWorkspace(pageData.parentId, workspaceId);
    }

    const generated = pageData.kind === PageKindEnum.GENERATED;

    // The gardener writes a generated page, from the entries each section
    // cites; a body sent with it would be a section citing nothing.
    if (generated && toStoredBody(pageData) !== undefined) {
      throw new BadRequestException({
        message:
          'A generated page is written from the knowledge in its scope, not ' +
          'given a body. Make it with a question, and link it to what it is ' +
          'about.',
      });
    }

    if (!generated && pageData.question !== undefined) {
      throw new BadRequestException({
        message: 'Only a generated page answers a question.',
      });
    }

    const question = generated ? questionOf(pageData.question) : null;

    const last = await this.prisma.page.findFirst({
      where: {
        workspaceId,
        deleted: null,
        parentId: pageData.parentId ?? null,
      },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });

    const page = await this.prisma.page.create({
      data: {
        title: pageData.title,
        description: toStoredBody(pageData) ?? null,
        parentId: pageData.parentId ?? null,
        sortOrder: pageData.sortOrder ?? (last?.sortOrder ?? 0) + 1,
        ...(pageData.entryPolicy ? { entryPolicy: pageData.entryPolicy } : {}),
        ...(generated
          ? { kind: PageKindEnum.GENERATED, question, sections: [] }
          : {}),
        workspaceId,
        createdById: userId,
        updatedById: userId,
      },
    });

    await this.recordHistory(page.id, userId, { created: { to: page.title } });
    await this.indexer?.pageChanged(page.id);

    if (generated) {
      await this.queueRefresh(page.id);
    }

    return this.withMarkdown(page);
  }

  async updatePage(
    pageId: string,
    userId: string,
    pageData: UpdatePageDto,
  ): Promise<PageResponse> {
    const current = await this.prisma.page.findFirst({
      where: { id: pageId, deleted: null },
      select: {
        title: true,
        description: true,
        parentId: true,
        entryPolicy: true,
        workspaceId: true,
        kind: true,
        question: true,
      },
    });

    if (!current) {
      throw new NotFoundException({ message: `Page ${pageId} not found` });
    }

    const wasGenerated = current.kind === PageKindEnum.GENERATED;
    const takenOver = wasGenerated && pageData.kind === PageKindEnum.AUTHORED;

    // A page people wrote is never handed to the gardener, which would
    // rewrite it whole: a generated page is made as one.
    if (!wasGenerated && pageData.kind === PageKindEnum.GENERATED) {
      throw new BadRequestException({
        message:
          'A page people wrote cannot become generated, which would replace ' +
          'its body. Make a generated page for the question instead.',
      });
    }

    // Taking a generated page over hands its body to people: from then on
    // it is a page people write, and an agent's text in it would be an edit
    // to such a page with no person involved.
    if (takenOver) {
      await this.assertPerson(
        userId,
        'A generated page is taken over by a person, who then writes it. ' +
          'Nothing was changed. To change what it says, correct the entries ' +
          'it is written from.',
      );
    }

    // Its body is its sections, rendered; an edit to the body alone would be
    // undone by the next refresh, or edit sections nothing records. Taking
    // the page over by hand makes it an authored page, edited like any other.
    if (wasGenerated && !takenOver && toStoredBody(pageData) !== undefined) {
      throw new BadRequestException({
        message:
          'A generated page is written from its entries: correct those. A ' +
          'person can take the page over by hand (kind AUTHORED) to edit its ' +
          'body.',
      });
    }

    if (pageData.question !== undefined && (!wasGenerated || takenOver)) {
      throw new BadRequestException({
        message: 'Only a generated page answers a question.',
      });
    }

    const question =
      pageData.question !== undefined ? questionOf(pageData.question) : null;
    const questionChanged = question !== null && question !== current.question;

    if (pageData.parentId !== undefined && pageData.parentId !== null) {
      await this.assertSameWorkspace(pageData.parentId, current.workspaceId);
      await this.assertNotAncestorOfItself(pageId, pageData.parentId);
    }

    const titleChanged =
      pageData.title !== undefined && pageData.title !== current.title;

    // Named one field at a time rather than spread. The global ValidationPipe
    // does not whitelist, so anything else the caller put in the body survives
    // validation and would reach Prisma: `workspaceId` would move the page into
    // another tenant, a nested `entries: { … }` would rewrite asserted facts,
    // and `deleted: null` would undo a delete.
    const page = await this.prisma.page.update({
      where: { id: pageId },
      data: {
        ...(pageData.title !== undefined && { title: pageData.title }),
        ...(toStoredBody(pageData) !== undefined && {
          description: toStoredBody(pageData),
        }),
        ...(pageData.parentId !== undefined && {
          parentId: pageData.parentId,
        }),
        ...(pageData.sortOrder !== undefined && {
          sortOrder: pageData.sortOrder,
        }),
        ...(pageData.entryPolicy !== undefined && {
          entryPolicy: pageData.entryPolicy,
        }),
        ...(takenOver && { kind: PageKindEnum.AUTHORED }),
        // A new question is a new page to build: the watermark goes, so the
        // next refresh does not wait for the evidence to change.
        ...(questionChanged && {
          question,
          watermark: null,
          evidenceHash: null,
        }),
        updatedById: userId,
      },
    });

    await this.recordHistory(
      pageId,
      userId,
      {
        ...(titleChanged
          ? { title: { from: current.title, to: pageData.title } }
          : {}),
        ...(pageData.parentId !== undefined &&
        pageData.parentId !== current.parentId
          ? { parentId: { from: current.parentId, to: pageData.parentId } }
          : {}),
        ...(pageData.entryPolicy !== undefined &&
        pageData.entryPolicy !== current.entryPolicy
          ? {
              entryPolicy: {
                from: current.entryPolicy,
                to: pageData.entryPolicy,
              },
            }
          : {}),
        ...(takenOver
          ? { kind: { from: current.kind, to: PageKindEnum.AUTHORED } }
          : {}),
        ...(questionChanged
          ? { question: { from: current.question, to: question } }
          : {}),
        ...(toStoredBody(pageData) !== undefined ? { body: true } : {}),
      },
      // Only when the body actually moved. Storing it on a title-only change
      // would fill the table with copies of an unchanged document and make the
      // history read as though every edit rewrote the page.
      toStoredBody(pageData) !== undefined ? current.description : undefined,
    );
    await this.indexer?.pageChanged(pageId, { titleChanged });

    if (questionChanged) {
      await this.queueRefresh(pageId);
    }

    return this.withMarkdown(page);
  }

  /**
   * Asks for a generated page to be built now rather than at the next look.
   * Best effort: the scheduled look builds it anyway.
   */
  private async queueRefresh(pageId: string): Promise<void> {
    try {
      await this.pagesQueue?.add(
        REFRESH_PAGE_JOB,
        { pageId },
        refreshPageJobOptions(pageId),
      );
    } catch {
      // The next scheduled look finds it.
    }
  }

  /**
   * Soft-deletes a page and everything under it.
   *
   * Deleting only the named page would leave its children pointing at a row
   * nothing can reach, which reads as data loss in the tree and as orphaned
   * knowledge in retrieval. Entries go with their page for the same reason: an
   * entry whose page is gone has no scope left to be true within.
   */
  async deletePage(pageId: string, userId: string): Promise<PageResponse> {
    const ids = await this.subtreeIds(pageId);
    const deleted = new Date();

    const entries = await this.prisma.pageEntry.findMany({
      where: { pageId: { in: ids }, deleted: null },
      select: { id: true },
    });
    const entryIds = entries.map((entry) => entry.id);

    await this.prisma.$transaction([
      this.prisma.pageEntry.updateMany({
        where: { pageId: { in: ids }, deleted: null },
        data: { deleted },
      }),
      this.prisma.page.updateMany({
        where: { id: { in: ids }, deleted: null },
        data: { deleted, updatedById: userId },
      }),
    ]);

    await this.recordHistory(pageId, userId, {
      deleted: { to: ids.length },
    });
    await this.indexer?.pageDeleted(ids, entryIds);

    return this.getDeletedPage(pageId);
  }

  /**
   * Proposes folding standing entries into a page body, for a person to
   * accept.
   *
   * This is the action that keeps the bank small. The caller supplies the
   * rewritten prose, because deciding how a set of facts reads as a
   * narrative is the judgment being asked for. It rewrites a body people
   * maintain wholesale, so nothing changes until a person accepts it
   * (`acceptProposal`): whoever asks, agent or person, gets a proposal, and a
   * person consolidating in the webapp accepts their own at once. A
   * generated page is refused: it is written from the entries it cites
   * already, and edited as they change.
   */
  async consolidate(
    pageId: string,
    userId: string,
    input: ConsolidatePageDto,
  ): Promise<PageProposal> {
    const page = await this.prisma.page.findFirst({
      where: { id: pageId, deleted: null },
      select: { id: true, title: true, kind: true },
    });

    if (!page) {
      throw new NotFoundException({ message: `Page ${pageId} not found` });
    }

    if (page.kind === PageKindEnum.GENERATED) {
      throw new BadRequestException({
        message:
          'A generated page is written from the entries it cites, and edited ' +
          'as they change: there is nothing to consolidate into it. Correct ' +
          'or add entries in its scope instead.',
      });
    }

    const entries = await this.prisma.pageEntry.findMany({
      where: {
        pageId,
        deleted: null,
        status: PageEntryStatusEnum.STANDING,
        ...(input.entryIds?.length ? { id: { in: input.entryIds } } : {}),
      },
      select: { id: true },
    });

    if (entries.length === 0) {
      throw new BadRequestException({
        message:
          'No standing entries on this page to consolidate. To change the ' +
          'body alone, edit the page.',
      });
    }

    const proposal = await this.prisma.pageProposal.create({
      data: {
        pageId,
        body: JSON.stringify(
          convertMarkdownToTiptapJson(input.descriptionMarkdown),
        ),
        entryIds: entries.map((entry) => entry.id),
        proposedById: userId,
      },
      select: PROPOSAL_SELECT,
    });

    return proposalResponse(proposal);
  }

  /** A page's proposals, newest first: the open ones unless told otherwise. */
  async getProposals(
    pageId: string,
    state: PageProposalStateEnum | 'ALL' = PageProposalStateEnum.OPEN,
  ): Promise<PageProposal[]> {
    const rows = await this.prisma.pageProposal.findMany({
      where: {
        pageId,
        page: { deleted: null },
        ...(state === 'ALL' ? {} : { state }),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: PROPOSAL_SELECT,
    });

    return rows.map(proposalResponse);
  }

  /**
   * A person accepts a proposed consolidation: the body becomes the one
   * proposed, the entries it folds in are marked CONSOLIDATED and cited by
   * the page, and the body it replaced is recorded in the page's history,
   * where the existing revert undoes it. The entries stay served, as
   * evidence ranked below the page.
   *
   * Refused when an entry it folds in is no longer standing, or the page
   * changed after it was proposed: the prose was written against both as
   * they were, and accepting it would state what an entry no longer says,
   * or undo an edit made since. Ask for it again instead.
   */
  async acceptProposal(
    pageId: string,
    proposalId: string,
    userId: string,
  ): Promise<PageResponse> {
    await this.assertPerson(userId);

    const proposal = await this.openProposal(pageId, proposalId);
    const page = await this.prisma.page.findFirst({
      where: { id: pageId, deleted: null },
      select: {
        description: true,
        kind: true,
        updatedAt: true,
        citedEntryIds: true,
      },
    });

    if (!page) {
      throw new NotFoundException({ message: `Page ${pageId} not found` });
    }

    if (page.kind !== PageKindEnum.AUTHORED) {
      throw new ConflictException({
        message: 'This page is generated now; its body is not proposed to.',
      });
    }

    if (page.updatedAt > proposal.createdAt) {
      throw new ConflictException({
        message:
          'The page changed after this was proposed, so accepting it would ' +
          'undo that change. Decline it and ask for it again.',
      });
    }

    const entries = await this.prisma.pageEntry.findMany({
      where: {
        id: { in: proposal.entryIds },
        pageId,
        deleted: null,
        status: PageEntryStatusEnum.STANDING,
      },
      select: { id: true },
    });

    if (entries.length !== proposal.entryIds.length) {
      const standing = new Set(entries.map((entry) => entry.id));

      throw new ConflictException({
        message:
          'Entries this folds in are no longer standing: ' +
          `${proposal.entryIds.filter((id) => !standing.has(id)).join(', ')}. ` +
          'Decline it and ask for it again.',
      });
    }

    // A person folding an entry drawn for audit into the page keeps it,
    // which answers the audit as keeping it by hand would.
    const verdicts =
      this.agreement && entries.length
        ? await this.agreement.verdictsFor(
            entries.map((entry) => ({
              id: entry.id,
              status: PageEntryStatusEnum.STANDING,
            })),
            { status: PageEntryStatusEnum.CONSOLIDATED, edited: false },
            userId,
          )
        : { operations: [], decisionIds: [], workspaceIds: [] };

    let updated: Awaited<ReturnType<typeof this.prisma.page.update>>;

    try {
      [, updated] = await this.prisma.$transaction([
        // Only while still open, and an error otherwise, which undoes the
        // rest: two people accepting at once fold it in once.
        this.prisma.pageProposal.update({
          where: { id: proposalId, state: PageProposalStateEnum.OPEN },
          data: {
            state: PageProposalStateEnum.ACCEPTED,
            decidedById: userId,
            decidedAt: new Date(),
          },
        }),
        this.prisma.page.update({
          where: { id: pageId },
          data: {
            description: proposal.body,
            citedEntryIds: [
              ...new Set([...page.citedEntryIds, ...proposal.entryIds]),
            ],
            updatedById: userId,
          },
        }),
        this.prisma.pageEntry.updateMany({
          where: {
            id: { in: proposal.entryIds },
            status: PageEntryStatusEnum.STANDING,
          },
          data: { status: PageEntryStatusEnum.CONSOLIDATED },
        }),
        this.prisma.pageHistory.create({
          data: {
            pageId,
            userId,
            changes: {
              body: true,
              consolidated: { to: proposal.entryIds.length },
              proposal: { to: proposalId },
            },
            previousBody: page.description ?? null,
          },
        }),
        ...verdicts.operations,
      ]);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new ConflictException({
          message: 'This proposal was answered meanwhile.',
        });
      }

      throw error;
    }

    await this.indexer?.pageChanged(pageId);
    await this.indexer?.entriesChanged(proposal.entryIds);
    await this.agreement?.reevaluateQuietly(verdicts.workspaceIds);

    return this.withMarkdown(updated);
  }

  /** A person declines a proposed consolidation. Nothing else changes. */
  async declineProposal(
    pageId: string,
    proposalId: string,
    userId: string,
  ): Promise<PageProposal> {
    await this.assertPerson(userId);
    await this.openProposal(pageId, proposalId);

    const { count } = await this.prisma.pageProposal.updateMany({
      where: { id: proposalId, pageId, state: PageProposalStateEnum.OPEN },
      data: {
        state: PageProposalStateEnum.DECLINED,
        decidedById: userId,
        decidedAt: new Date(),
      },
    });

    if (count === 0) {
      throw new ConflictException({
        message: 'This proposal was answered meanwhile.',
      });
    }

    const row = await this.prisma.pageProposal.findUniqueOrThrow({
      where: { id: proposalId },
      select: PROPOSAL_SELECT,
    });

    return proposalResponse(row);
  }

  /** An open proposal on a live page, or why not. */
  private async openProposal(pageId: string, proposalId: string) {
    const proposal = await this.prisma.pageProposal.findFirst({
      where: { id: proposalId, pageId, page: { deleted: null } },
      select: {
        id: true,
        body: true,
        entryIds: true,
        state: true,
        createdAt: true,
      },
    });

    if (!proposal) {
      throw new NotFoundException({
        message: `No proposal ${proposalId} on page ${pageId}`,
      });
    }

    if (proposal.state !== PageProposalStateEnum.OPEN) {
      throw new ConflictException({
        message: `This proposal was already answered: ${proposal.state.toLowerCase()}.`,
      });
    }

    return proposal;
  }

  /**
   * Accepting or declining a change to a page people maintain, and taking a
   * generated page over by hand, are for people. The controller refuses
   * agent tokens first; this holds for any other caller.
   */
  private async assertPerson(
    userId: string,
    message = 'A change to a page people maintain is accepted or declined by ' +
      'a person.',
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { type: true },
    });

    if (
      !user ||
      user.type === UserTypeEnum.Agent ||
      user.type === UserTypeEnum.System
    ) {
      throw new ForbiddenException({ message });
    }
  }

  /**
   * What has happened to this page, newest first.
   *
   * The body of each revision comes back as markdown rather than tiptap JSON,
   * for the same reason every other read does: nothing outside the editor
   * should have to parse editor JSON to find out what a page used to say.
   */
  async getHistory(pageId: string): Promise<PageRevision[]> {
    const rows = await this.prisma.pageHistory.findMany({
      where: { pageId, deleted: null },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return rows.map((row) => ({
      id: row.id,
      pageId: row.pageId,
      userId: row.userId,
      createdAt: row.createdAt.toISOString(),
      changes: (row.changes ?? {}) as Record<string, unknown>,
      previousBodyMarkdown: row.previousBody
        ? convertTiptapJsonToMarkdown(row.previousBody)
        : null,
    }));
  }

  /**
   * Puts the body back to what it was before one recorded change.
   *
   * The revert is itself an edit — it records its own history row carrying the
   * body it replaced — so undoing an agent's rewrite is not a hole in the trail
   * and can in turn be undone. A revert that erased its own evidence would make
   * the history lie about what the page has been.
   *
   * Reverting the acceptance of a consolidation undoes it: the entries it
   * folded in, where still CONSOLIDATED, are put back in use as standing
   * entries and are no longer cited by the page, whose body no longer says
   * them.
   */
  async revertBody(
    pageId: string,
    historyId: string,
    userId: string,
  ): Promise<PageResponse> {
    const revision = await this.prisma.pageHistory.findFirst({
      where: { id: historyId, pageId, deleted: null },
      select: { previousBody: true, previousSections: true, changes: true },
    });

    if (!revision) {
      throw new NotFoundException({
        message: `No change ${historyId} on page ${pageId}`,
      });
    }

    if (revision.previousBody === null) {
      throw new BadRequestException({
        message:
          'That change did not touch the body, so there is no earlier version ' +
          'of it to go back to.',
      });
    }

    const current = await this.prisma.page.findFirst({
      where: { id: pageId, deleted: null },
      select: {
        description: true,
        kind: true,
        sections: true,
        citedEntryIds: true,
      },
    });

    if (!current) {
      throw new NotFoundException({ message: `Page ${pageId} not found` });
    }

    // A generated page's sections go back with its body, or the next refresh
    // would edit sections the body no longer shows. What it cites follows.
    const generated = current.kind === PageKindEnum.GENERATED;
    const sections = generated ? readSections(revision.previousSections) : [];
    const unfolded = generated ? [] : await this.acceptedEntries(revision);
    const folded = new Set(unfolded);

    const [page, restored] = await this.prisma.$transaction([
      this.prisma.page.update({
        where: { id: pageId },
        data: {
          description: revision.previousBody,
          ...(generated
            ? {
                sections: sections as unknown as Prisma.InputJsonValue,
                citedEntryIds: citedBy(sections),
              }
            : folded.size
              ? {
                  citedEntryIds: current.citedEntryIds.filter(
                    (id) => !folded.has(id),
                  ),
                }
              : {}),
          updatedById: userId,
        },
      }),
      this.prisma.pageEntry.updateMany({
        where: {
          id: { in: unfolded },
          pageId,
          deleted: null,
          status: PageEntryStatusEnum.CONSOLIDATED,
        },
        data: { status: PageEntryStatusEnum.STANDING },
      }),
    ]);

    await this.recordHistory(
      pageId,
      userId,
      {
        body: true,
        revertedTo: { to: historyId },
        ...(restored.count ? { unconsolidated: { to: restored.count } } : {}),
      },
      current.description,
      generated ? current.sections : undefined,
    );
    await this.indexer?.pageChanged(pageId);

    if (unfolded.length) {
      await this.indexer?.entriesChanged(unfolded);
    }

    return this.withMarkdown(page);
  }

  /** The entries an accepted consolidation, recorded as this change, folded in. */
  private async acceptedEntries(revision: {
    changes: Prisma.JsonValue;
  }): Promise<string[]> {
    const changes = revision.changes as {
      proposal?: { to?: unknown };
    } | null;
    const proposalId = changes?.proposal?.to;

    if (typeof proposalId !== 'string') {
      return [];
    }

    // Only accepting writes a change naming its proposal.
    const proposal = await this.prisma.pageProposal.findFirst({
      where: { id: proposalId },
      select: { entryIds: true },
    });

    return proposal?.entryIds ?? [];
  }

  // --------------------------------------------------------------- internals

  /**
   * Every page in the subtree rooted at `pageId`, including the root.
   *
   * Walked level by level rather than recursively in SQL: the depth of a
   * documentation tree is small, and `seen` makes a cycle written directly into
   * the database terminate rather than spin.
   */
  private async subtreeIds(pageId: string): Promise<string[]> {
    const seen = new Set<string>([pageId]);
    let frontier = [pageId];

    while (frontier.length > 0) {
      const children = await this.prisma.page.findMany({
        where: { parentId: { in: frontier }, deleted: null },
        select: { id: true },
      });

      frontier = children
        .map((child) => child.id)
        .filter((id) => !seen.has(id));

      frontier.forEach((id) => seen.add(id));
    }

    return [...seen];
  }

  /**
   * Refuses a reparent that would make a page its own ancestor.
   *
   * A cycle is not a cosmetic problem: the breadcrumb walk, the subtree delete
   * and the tree render all follow parent pointers, and a loop turns each of
   * them into an infinite one.
   */
  private async assertNotAncestorOfItself(
    pageId: string,
    parentId: string,
  ): Promise<void> {
    if (pageId === parentId) {
      throw new BadRequestException({
        message: 'A page cannot be its own parent',
      });
    }

    const descendants = await this.subtreeIds(pageId);

    if (descendants.includes(parentId)) {
      throw new BadRequestException({
        message: 'A page cannot be moved underneath one of its own children',
      });
    }
  }

  private async assertSameWorkspace(
    parentId: string,
    workspaceId: string,
  ): Promise<void> {
    const parent = await this.prisma.page.findFirst({
      where: { id: parentId, deleted: null, workspaceId },
      select: { id: true },
    });

    if (!parent) {
      throw new NotFoundException({ message: `Page ${parentId} not found` });
    }
  }

  private async getDeletedPage(pageId: string): Promise<PageResponse> {
    const page = await this.prisma.page.findUnique({ where: { id: pageId } });
    return this.withMarkdown(page);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async recordHistory(
    pageId: string,
    userId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    changes: Record<string, any>,
    previousBody?: string | null,
    previousSections?: Prisma.JsonValue,
  ): Promise<void> {
    if (Object.keys(changes).length === 0) {
      return;
    }

    await this.prisma.pageHistory.create({
      data: {
        pageId,
        userId,
        changes,
        previousBody: previousBody ?? null,
        ...(previousSections !== undefined && previousSections !== null
          ? { previousSections: previousSections as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  /**
   * The markdown boundary. Bodies are tiptap JSON in the database, but no
   * caller should ever have to parse editor JSON to read a page — the same
   * boundary the issue endpoints and search hits already honour.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private withMarkdown(page: any): PageResponse {
    return {
      ...page,
      descriptionMarkdown: convertTiptapJsonToMarkdown(page.description ?? ''),
    };
  }
}
