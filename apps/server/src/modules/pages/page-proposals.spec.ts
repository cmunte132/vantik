import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PageEntryStatusEnum,
  PageKindEnum,
  PageProposalStateEnum,
  RoleEnum,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { convertMarkdownToTiptapJson } from 'common/utils/tiptap.utils';

import KnowledgeIndexService from './knowledge-index.service';
import PageLinksService from './page-links.service';
import { PagesController } from './pages.controller';
import PagesService from './pages.service';

/**
 * Consolidating entries into a page people write. Whoever asks gets a
 * proposal; nothing about the page changes until a person accepts it, and
 * the entries it folds in stay served, as evidence the page cites.
 *
 * Built over an in-memory store that answers the filters the service
 * writes. A write handed to a transaction runs only when the transaction
 * runs it, and a transaction that throws is undone.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const WORKSPACE = 'workspace-1';
const PAGE = 'page-auth';
const GENERATED = 'page-gen';
const OTHER = 'page-other';

const USERS: Record<string, string> = {
  'person-1': 'User',
  'person-2': 'User',
  'agent-1': 'Agent',
  'system-1': 'System',
};

const body = (markdown: string) =>
  JSON.stringify(convertMarkdownToTiptapJson(markdown));
const BEFORE = body('## Runbook\n\nRestart the worker.');
const PROPOSED =
  '## Runbook\n\nRestart the worker; it drains its queue first, and ' +
  'deploys go out behind a canary.';

function lazy<T>(run: () => T): Promise<T> {
  let started: Promise<T> | undefined;
  const start = () => (started ??= Promise.resolve().then(run));

  return {
    then: (resolve, reject) => start().then(resolve, reject),
    catch: (reject) => start().catch(reject),
    finally: (done) => start().finally(done),
    [Symbol.toStringTag]: 'Promise',
  } as Promise<T>;
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];

    if (condition === null) {
      return value === null || value === undefined;
    }

    if (typeof condition === 'object' && !Array.isArray(condition)) {
      if ('in' in condition) {
        return (condition.in as unknown[]).includes(value);
      }

      // A relation, matched against the related row.
      return (
        typeof value === 'object' && value !== null && matches(value, condition)
      );
    }

    return value === condition;
  });
}

function setup() {
  let clock = 10_000;
  const at = () => new Date(++clock);

  const pages = new Map<string, Row>(
    [
      {
        id: PAGE,
        title: 'Runbook',
        kind: PageKindEnum.AUTHORED,
        description: BEFORE,
        citedEntryIds: ['e-old'],
      },
      {
        id: GENERATED,
        title: 'Deploying',
        kind: PageKindEnum.GENERATED,
        description: body('## Deploying\n\nMerge to main.'),
        citedEntryIds: [] as string[],
      },
      {
        id: OTHER,
        title: 'Other',
        kind: PageKindEnum.AUTHORED,
        description: null,
        citedEntryIds: [] as string[],
      },
    ].map((page) => [
      page.id,
      {
        ...page,
        workspaceId: WORKSPACE,
        deleted: null as Date | null,
        updatedAt: at(),
      },
    ]),
  );
  const entries: Row[] = [
    ['e1', PAGE, PageEntryStatusEnum.STANDING],
    ['e2', PAGE, PageEntryStatusEnum.STANDING],
    ['e3', PAGE, PageEntryStatusEnum.STANDING],
    ['e-proposed', PAGE, PageEntryStatusEnum.PROPOSED],
    ['e-old', PAGE, PageEntryStatusEnum.CONSOLIDATED],
    ['e-gen', GENERATED, PageEntryStatusEnum.STANDING],
  ].map(([id, pageId, status]) => ({
    id,
    pageId,
    status,
    deleted: null as Date | null,
  }));
  const proposals: Row[] = [];
  const history: Row[] = [];

  const proposalView = (row: Row): Row => ({
    ...row,
    page: pages.get(row.pageId as string),
  });
  const notFound = () =>
    new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
      code: 'P2025',
      clientVersion: 'test',
    });
  const set = (row: Row, data: Row) => Object.assign(row, data);

  const snapshot = () => ({
    pages: [...pages.values()].map((row) => structuredClone(row)),
    entries: structuredClone(entries),
    proposals: structuredClone(proposals),
    history: structuredClone(history),
  });
  const restore = (saved: ReturnType<typeof snapshot>) => {
    saved.pages.forEach((row) => pages.set(row.id, row));
    entries.splice(0, entries.length, ...saved.entries);
    proposals.splice(0, proposals.length, ...saved.proposals);
    history.splice(0, history.length, ...saved.history);
  };

  let running: Promise<unknown> = Promise.resolve();
  const prisma = {
    page: {
      findFirst: jest.fn(({ where }: Row) =>
        lazy(() => {
          const row = [...pages.values()].find((page) => matches(page, where));

          return row ? structuredClone(row) : null;
        }),
      ),
      update: jest.fn(({ where, data }: Row) =>
        lazy(() => {
          const row = pages.get(where.id) as Row;
          set(row, { ...data, updatedAt: at() });

          return structuredClone(row);
        }),
      ),
    },
    pageEntry: {
      findMany: jest.fn(({ where }: Row) =>
        lazy(() =>
          entries
            .filter((row) => matches(row, where))
            .map((row) => ({ id: row.id })),
        ),
      ),
      updateMany: jest.fn(({ where, data }: Row) =>
        lazy(() => {
          const hit = entries.filter((row) => matches(row, where));
          hit.forEach((row) => set(row, data));

          return { count: hit.length };
        }),
      ),
    },
    pageProposal: {
      create: jest.fn(({ data }: Row) =>
        lazy(() => {
          const row = {
            id: `proposal-${proposals.length + 1}`,
            createdAt: at(),
            state: PageProposalStateEnum.OPEN,
            decidedById: null as string | null,
            decidedAt: null as Date | null,
            ...data,
          };
          proposals.push(row);

          return proposalView(row);
        }),
      ),
      findFirst: jest.fn(({ where }: Row) =>
        lazy(
          () =>
            proposals.map(proposalView).find((row) => matches(row, where)) ??
            null,
        ),
      ),
      findMany: jest.fn(({ where, orderBy, take }: Row) =>
        lazy(() =>
          proposals
            .map(proposalView)
            .filter((row) => matches(row, where))
            .sort(
              (a, b) =>
                (a.createdAt.getTime() - b.createdAt.getTime()) *
                (orderBy?.createdAt === 'desc' ? -1 : 1),
            )
            .slice(0, take),
        ),
      ),
      findUniqueOrThrow: jest.fn(({ where }: Row) =>
        lazy(() =>
          proposalView(proposals.find((row) => row.id === where.id) as Row),
        ),
      ),
      // As Prisma's: a row the filter no longer matches is an error.
      update: jest.fn(({ where, data }: Row) =>
        lazy(() => {
          const row = proposals.find((candidate) => matches(candidate, where));

          if (!row) {
            throw notFound();
          }

          return set(row, data);
        }),
      ),
      updateMany: jest.fn(({ where, data }: Row) =>
        lazy(() => {
          const hit = proposals.filter((row) => matches(row, where));
          hit.forEach((row) => set(row, data));

          return { count: hit.length };
        }),
      ),
    },
    pageHistory: {
      create: jest.fn(({ data }: Row) =>
        lazy(() => {
          const row = {
            id: `history-${history.length + 1}`,
            deleted: null as Date | null,
            ...data,
          };
          history.push(row);

          return row;
        }),
      ),
      findFirst: jest.fn(({ where }: Row) =>
        lazy(() => history.find((row) => matches(row, where)) ?? null),
      ),
    },
    user: {
      findUnique: jest.fn(({ where }: Row) =>
        lazy(() => (USERS[where.id] ? { type: USERS[where.id] } : null)),
      ),
    },
    // One at a time, as the rows they write lock: a transaction sees the
    // one before it land or be undone.
    $transaction: jest.fn((work: Array<Promise<unknown>>) => {
      const run = running.then(async () => {
        const saved = snapshot();

        try {
          const results: unknown[] = [];
          for (const operation of work) {
            results.push(await operation);
          }

          return results;
        } catch (error) {
          restore(saved);
          throw error;
        }
      });
      running = run.catch((): void => undefined);

      return run;
    }),
  };

  const indexer = {
    pageChanged: jest.fn(async (): Promise<void> => undefined),
    entriesChanged: jest.fn(async (): Promise<void> => undefined),
  };
  const service = new PagesService(
    prisma as unknown as PrismaService,
    indexer as unknown as KnowledgeIndexService,
  );
  const controller = new PagesController(
    service,
    {} as PageLinksService,
    prisma as unknown as PrismaService,
  );

  const status = (id: string) => entries.find((row) => row.id === id)?.status;
  const page = (id = PAGE) => pages.get(id) as Row;
  /** Everything a proposal's answer could have changed, to compare. */
  const state = () =>
    JSON.stringify({
      pages: [...pages.values()],
      entries,
      proposals,
      history,
    });

  return {
    service,
    controller,
    prisma,
    indexer,
    entries,
    proposals,
    history,
    status,
    page,
    state,
  };
}

type Setup = ReturnType<typeof setup>;

async function proposed(t: Setup, userId = 'agent-1', entryIds?: string[]) {
  return t.service.consolidate(PAGE, userId, {
    descriptionMarkdown: PROPOSED,
    ...(entryIds ? { entryIds } : {}),
  });
}

describe('consolidating entries into a page people write', () => {
  it('[KG-7.4] proposes the body, whoever asks, and changes nothing else', async () => {
    for (const userId of ['agent-1', 'person-1']) {
      const t = setup();
      const before = JSON.stringify({ page: t.page(), entries: t.entries });

      const proposal = await proposed(t, userId);

      expect(proposal).toMatchObject({
        pageId: PAGE,
        pageTitle: 'Runbook',
        entryIds: ['e1', 'e2', 'e3'],
        proposedById: userId,
        state: PageProposalStateEnum.OPEN,
        decidedById: null,
        decidedAt: null,
      });
      expect(proposal.bodyMarkdown).toContain('behind a canary');
      expect(typeof proposal.createdAt).toBe('string');
      // The page and its entries are as they were.
      expect(JSON.stringify({ page: t.page(), entries: t.entries })).toBe(
        before,
      );
      expect(t.history).toEqual([]);
      expect(t.indexer.pageChanged).not.toHaveBeenCalled();
      expect(t.indexer.entriesChanged).not.toHaveBeenCalled();
    }
  });

  it('[KG-7.4] folds in only the standing entries it is asked to', async () => {
    const t = setup();

    const proposal = await proposed(t, 'agent-1', [
      'e2',
      'e-proposed',
      'e-old',
    ]);

    expect(proposal.entryIds).toEqual(['e2']);
  });

  it('[KG-7.4] refuses a generated page, a page with nothing standing, and a missing page, and writes nothing', async () => {
    const t = setup();
    const before = t.state();

    await expect(
      t.service.consolidate(GENERATED, 'person-1', {
        descriptionMarkdown: PROPOSED,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      t.service.consolidate(OTHER, 'person-1', {
        descriptionMarkdown: PROPOSED,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      proposed(t, 'person-1', ['e-proposed']),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      t.service.consolidate('page-missing', 'person-1', {
        descriptionMarkdown: PROPOSED,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(t.state()).toBe(before);
  });

  it('[KG-7.4] a person accepting it replaces the body, keeps the entries as evidence the page cites, and records it', async () => {
    const t = setup();
    const proposal = await proposed(t);

    const page = await t.service.acceptProposal(PAGE, proposal.id, 'person-1');

    expect(page.descriptionMarkdown).toContain('behind a canary');
    expect(t.page().description).toBe(
      t.proposals.find((row) => row.id === proposal.id)?.body,
    );
    // Cited by the page, and still served: consolidated, not retired.
    expect(t.page().citedEntryIds).toEqual(['e-old', 'e1', 'e2', 'e3']);
    for (const id of ['e1', 'e2', 'e3']) {
      expect(t.status(id)).toBe(PageEntryStatusEnum.CONSOLIDATED);
      expect(t.entries.find((row) => row.id === id)?.deleted).toBeNull();
    }
    expect(t.status('e-proposed')).toBe(PageEntryStatusEnum.PROPOSED);
    expect(t.history).toEqual([
      expect.objectContaining({
        pageId: PAGE,
        userId: 'person-1',
        changes: {
          body: true,
          consolidated: { to: 3 },
          proposal: { to: proposal.id },
        },
        previousBody: BEFORE,
      }),
    ]);
    expect(t.proposals[0]).toMatchObject({
      state: PageProposalStateEnum.ACCEPTED,
      decidedById: 'person-1',
      decidedAt: expect.any(Date),
    });
    expect(t.indexer.pageChanged).toHaveBeenCalledWith(PAGE);
    expect(t.indexer.entriesChanged).toHaveBeenCalledWith(['e1', 'e2', 'e3']);
  });

  it('[KG-7.4] the existing revert undoes an accepted consolidation, putting its entries back in use', async () => {
    const t = setup();
    const proposal = await proposed(t);
    await t.service.acceptProposal(PAGE, proposal.id, 'person-1');
    // One entry moved on since: it is not put back.
    t.entries.find((row) => row.id === 'e3')!.status =
      PageEntryStatusEnum.SUPERSEDED;
    t.indexer.entriesChanged.mockClear();

    const page = await t.service.revertBody(PAGE, 'history-1', 'person-2');

    expect(page.description).toBe(BEFORE);
    expect(t.page().citedEntryIds).toEqual(['e-old']);
    expect(t.status('e1')).toBe(PageEntryStatusEnum.STANDING);
    expect(t.status('e2')).toBe(PageEntryStatusEnum.STANDING);
    expect(t.status('e3')).toBe(PageEntryStatusEnum.SUPERSEDED);
    expect(t.status('e-old')).toBe(PageEntryStatusEnum.CONSOLIDATED);
    expect(t.history[1]).toMatchObject({
      changes: {
        body: true,
        revertedTo: { to: 'history-1' },
        unconsolidated: { to: 2 },
      },
      previousBody: t.proposals[0].body,
    });
    expect(t.indexer.entriesChanged).toHaveBeenCalledWith(['e1', 'e2', 'e3']);

    // Reverting the revert is an edit to the body alone.
    await t.service.revertBody(PAGE, 'history-2', 'person-2');
    expect(t.page().description).toBe(t.proposals[0].body);
    expect(t.status('e1')).toBe(PageEntryStatusEnum.STANDING);
    expect(t.page().citedEntryIds).toEqual(['e-old']);
    expect(t.history[2].changes).toEqual({
      body: true,
      revertedTo: { to: 'history-2' },
    });
  });

  it('[KG-7.4] is accepted and declined by people only', async () => {
    const t = setup();
    const proposal = await proposed(t);
    const before = t.state();

    for (const userId of ['agent-1', 'system-1', 'nobody']) {
      await expect(
        t.service.acceptProposal(PAGE, proposal.id, userId),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        t.service.declineProposal(PAGE, proposal.id, userId),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }

    // An agent's token is refused before the service is asked.
    const params = { pageId: PAGE, proposalId: proposal.id };
    t.prisma.user.findUnique.mockClear();
    await expect(
      t.controller.acceptProposal('person-1', RoleEnum.AGENT, params),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      t.controller.declineProposal('person-1', RoleEnum.AGENT, params),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.prisma.user.findUnique).not.toHaveBeenCalled();

    expect(t.state()).toBe(before);

    await expect(
      t.controller.acceptProposal('person-1', RoleEnum.USER, params),
    ).resolves.toMatchObject({ id: PAGE });
    expect(t.proposals[0].state).toBe(PageProposalStateEnum.ACCEPTED);
  });

  it('[KG-7.4] is answered once', async () => {
    const t = setup();
    const accepted = await proposed(t);
    await t.service.acceptProposal(PAGE, accepted.id, 'person-1');
    const before = t.state();

    await expect(
      t.service.acceptProposal(PAGE, accepted.id, 'person-2'),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      t.service.declineProposal(PAGE, accepted.id, 'person-2'),
    ).rejects.toThrow('This proposal was already answered: accepted.');
    expect(t.state()).toBe(before);

    const u = setup();
    const declined = await proposed(u);
    await u.service.declineProposal(PAGE, declined.id, 'person-1');
    const declinedState = u.state();

    await expect(
      u.service.acceptProposal(PAGE, declined.id, 'person-2'),
    ).rejects.toThrow('This proposal was already answered: declined.');
    await expect(
      u.service.declineProposal(PAGE, declined.id, 'person-2'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(u.state()).toBe(declinedState);
  });

  it('[KG-7.4] of two people accepting at once, folds it in once', async () => {
    const t = setup();
    const proposal = await proposed(t);

    const results = await Promise.allSettled([
      t.service.acceptProposal(PAGE, proposal.id, 'person-1'),
      t.service.acceptProposal(PAGE, proposal.id, 'person-2'),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult)
        .reason,
    ).toBeInstanceOf(ConflictException);
    expect(t.history).toHaveLength(1);
    expect(t.page().citedEntryIds).toEqual(['e-old', 'e1', 'e2', 'e3']);
    expect(t.indexer.pageChanged).toHaveBeenCalledTimes(1);
  });

  it('[KG-7.4] of two answers at once, keeps the first and undoes the second with its change', async () => {
    const t = setup();
    const proposal = await proposed(t);
    // Both read the proposal open, and the decline lands first.
    await Promise.allSettled([
      t.service.declineProposal(PAGE, proposal.id, 'person-2'),
      t.service.acceptProposal(PAGE, proposal.id, 'person-1'),
    ]);

    expect(t.proposals[0]).toMatchObject({
      state: PageProposalStateEnum.DECLINED,
      decidedById: 'person-2',
    });
    expect(t.page().description).toBe(BEFORE);
    expect(t.page().citedEntryIds).toEqual(['e-old']);
    expect(t.status('e1')).toBe(PageEntryStatusEnum.STANDING);
    expect(t.history).toEqual([]);
  });

  it('[KG-7.4] of two answers at once, refuses a decline read before the acceptance landed', async () => {
    const t = setup();
    const proposal = await proposed(t);
    const stale = { ...t.proposals[0], page: t.page() };
    await t.service.acceptProposal(PAGE, proposal.id, 'person-1');
    const accepted = t.state();

    // The decline read the proposal while it was still open.
    t.prisma.pageProposal.findFirst.mockImplementationOnce(() =>
      Promise.resolve(stale),
    );
    await expect(
      t.service.declineProposal(PAGE, proposal.id, 'person-2'),
    ).rejects.toThrow('This proposal was answered meanwhile.');

    expect(t.state()).toBe(accepted);
    expect(t.proposals[0]).toMatchObject({
      state: PageProposalStateEnum.ACCEPTED,
      decidedById: 'person-1',
    });
  });

  it('[KG-7.4] is refused once the page or an entry it folds in has moved on, and writes nothing', async () => {
    // The page was edited after the proposal was written.
    const edited = setup();
    const onEdited = await proposed(edited);
    edited.page().updatedAt = new Date(Date.parse(onEdited.createdAt) + 1);
    let before = edited.state();
    await expect(
      edited.service.acceptProposal(PAGE, onEdited.id, 'person-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(edited.state()).toBe(before);

    // An entry it folds in is no longer standing.
    const moved = setup();
    const onMoved = await proposed(moved);
    moved.entries.find((row) => row.id === 'e2')!.status =
      PageEntryStatusEnum.SUPERSEDED;
    before = moved.state();
    await expect(
      moved.service.acceptProposal(PAGE, onMoved.id, 'person-1'),
    ).rejects.toThrow(/e2/);
    expect(moved.state()).toBe(before);

    // Or was deleted.
    const deleted = setup();
    const onDeleted = await proposed(deleted);
    deleted.entries.find((row) => row.id === 'e1')!.deleted = new Date();
    before = deleted.state();
    await expect(
      deleted.service.acceptProposal(PAGE, onDeleted.id, 'person-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(deleted.state()).toBe(before);

    // The page is generated now.
    const generated = setup();
    const onGenerated = await proposed(generated);
    generated.page().kind = PageKindEnum.GENERATED;
    before = generated.state();
    await expect(
      generated.service.acceptProposal(PAGE, onGenerated.id, 'person-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(generated.state()).toBe(before);

    // The page is gone.
    const gone = setup();
    const onGone = await proposed(gone);
    gone.page().deleted = new Date();
    before = gone.state();
    await expect(
      gone.service.acceptProposal(PAGE, onGone.id, 'person-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(gone.state()).toBe(before);
  });

  it('[KG-7.4] is answered only on its own page', async () => {
    const t = setup();
    const proposal = await proposed(t);
    const before = t.state();

    await expect(
      t.service.acceptProposal(OTHER, proposal.id, 'person-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      t.service.declineProposal(OTHER, proposal.id, 'person-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(t.state()).toBe(before);
  });

  it('[KG-7.4] declining it changes nothing but the proposal', async () => {
    const t = setup();
    const proposal = await proposed(t);
    const before = JSON.stringify({ page: t.page(), entries: t.entries });

    const declined = await t.service.declineProposal(
      PAGE,
      proposal.id,
      'person-1',
    );

    expect(declined).toMatchObject({
      id: proposal.id,
      state: PageProposalStateEnum.DECLINED,
      decidedById: 'person-1',
      decidedAt: expect.any(String),
    });
    expect(JSON.stringify({ page: t.page(), entries: t.entries })).toBe(before);
    expect(t.history).toEqual([]);
    expect(t.indexer.pageChanged).not.toHaveBeenCalled();
  });

  it('[KG-7.4] lists a page’s open proposals, newest first, or every one', async () => {
    const t = setup();
    const first = await proposed(t, 'agent-1', ['e1']);
    const second = await proposed(t, 'person-1', ['e2']);
    const third = await proposed(t, 'agent-1', ['e3']);
    await t.service.declineProposal(PAGE, second.id, 'person-1');

    expect((await t.service.getProposals(PAGE)).map((row) => row.id)).toEqual([
      third.id,
      first.id,
    ]);
    expect(
      (await t.service.getProposals(PAGE, 'ALL')).map((row) => row.id),
    ).toEqual([third.id, second.id, first.id]);
    expect(
      (await t.controller.getProposals({ pageId: PAGE }, 'DECLINED')).map(
        (row) => row.id,
      ),
    ).toEqual([second.id]);
    expect(
      (await t.controller.getProposals({ pageId: PAGE }, 'bogus')).map(
        (row) => row.id,
      ),
    ).toEqual([third.id, first.id]);
    expect(await t.service.getProposals(OTHER)).toEqual([]);
  });
});
