import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PageKindEnum, RoleEnum } from '@vantikhq/types';
import { Queue } from 'bull';
import { PrismaService } from 'nestjs-prisma';

import { convertMarkdownToTiptapJson } from 'common/utils/tiptap.utils';

import KnowledgeIndexService from '../knowledge-index.service';
import PageLinksService from '../page-links.service';
import { PagesController } from '../pages.controller';
import { REFRESH_PAGE_JOB } from '../pages.interface';
import PagesService from '../pages.service';

/**
 * Authored and generated pages, as people make and edit them. A generated
 * page answers a question and is written by the gardener from the entries
 * its sections cite; a page people write is never handed to it.
 */

const WORKSPACE = 'workspace-1';
const USER = 'user-1';
const HOUR = 60 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function setup(current?: Row, userType = 'User') {
  const prisma = {
    user: {
      findUnique: jest.fn(async (): Promise<Row> => ({ type: userType })),
    },
    page: {
      findFirst: jest.fn(async ({ where }: Row) =>
        current && where.id === current.id ? { ...current } : null,
      ),
      create: jest.fn(async ({ data }: Row) => ({
        id: 'page-new',
        kind: PageKindEnum.AUTHORED,
        question: null,
        description: null,
        ...data,
      })),
      update: jest.fn(async ({ where, data }: Row) => ({
        ...current,
        id: where.id,
        ...data,
      })),
    },
    pageHistory: {
      create: jest.fn(async (args: Row): Promise<Row> => args),
    },
  };
  const queue = {
    add: jest.fn<Promise<Row>, unknown[]>(async () => ({})),
  };
  const indexer = {
    pageChanged: jest.fn(async (): Promise<void> => undefined),
  } as unknown as KnowledgeIndexService;
  const service = new PagesService(
    prisma as unknown as PrismaService,
    indexer,
    undefined,
    queue as unknown as Queue,
  );

  const controller = new PagesController(
    service,
    {} as PageLinksService,
    prisma as unknown as PrismaService,
  );

  return {
    service,
    controller,
    prisma,
    queue,
    expectNothingWritten: () => {
      expect(prisma.page.create).not.toHaveBeenCalled();
      expect(prisma.page.update).not.toHaveBeenCalled();
      expect(prisma.pageHistory.create).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    },
  };
}

const BODY = JSON.stringify(convertMarkdownToTiptapJson('## Deploying\n\nb'));
const GENERATED: Row = {
  id: 'page-gen',
  title: 'Deploying',
  description: BODY,
  parentId: null,
  entryPolicy: 'OPEN',
  workspaceId: WORKSPACE,
  kind: PageKindEnum.GENERATED,
  question: 'How do we deploy the server?',
};
const AUTHORED: Row = {
  ...GENERATED,
  id: 'page-auth',
  kind: PageKindEnum.AUTHORED,
  question: null,
};

describe('authored and generated pages', () => {
  it('[KG-7.1] makes a page people write unless asked for a generated one', async () => {
    const { service, prisma, queue } = setup();

    const page = await service.createPage(WORKSPACE, USER, {
      title: 'Runbook',
      descriptionMarkdown: 'Restart the worker.',
    });

    // The column's default: AUTHORED.
    expect(prisma.page.create.mock.calls[0][0].data).not.toHaveProperty('kind');
    expect(page.kind).toBe(PageKindEnum.AUTHORED);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('[KG-7.1] makes a generated page with the question it answers, no body, and asks for its first build', async () => {
    const { service, prisma, queue } = setup();

    const page = await service.createPage(WORKSPACE, USER, {
      title: 'Deploying',
      kind: PageKindEnum.GENERATED,
      question: '  How do we deploy the server?  ',
    });

    expect(prisma.page.create.mock.calls[0][0].data).toMatchObject({
      kind: PageKindEnum.GENERATED,
      question: 'How do we deploy the server?',
      sections: [],
    });
    expect(prisma.page.create.mock.calls[0][0].data.description).toBeNull();
    expect(page).toMatchObject({
      kind: PageKindEnum.GENERATED,
      question: 'How do we deploy the server?',
    });
    expect(queue.add).toHaveBeenCalledWith(
      REFRESH_PAGE_JOB,
      { pageId: 'page-new' },
      expect.objectContaining({ jobId: `${REFRESH_PAGE_JOB}:page-new` }),
    );
  });

  it('[KG-7.1] still makes a generated page when its first build cannot be queued', async () => {
    const { service, queue } = setup();
    queue.add.mockRejectedValueOnce(new Error('redis is down'));

    await expect(
      service.createPage(WORKSPACE, USER, {
        title: 'Deploying',
        kind: PageKindEnum.GENERATED,
        question: 'How do we deploy the server?',
      }),
    ).resolves.toMatchObject({ kind: PageKindEnum.GENERATED });
  });

  it('[KG-7.1] refuses a generated page with no question, and writes nothing', async () => {
    for (const question of [undefined, '', '   ', 'x'.repeat(501)]) {
      const { service, expectNothingWritten } = setup();

      await expect(
        service.createPage(WORKSPACE, USER, {
          title: 'Deploying',
          kind: PageKindEnum.GENERATED,
          question,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expectNothingWritten();
    }
  });

  it('[KG-7.1] refuses a body for a generated page, which its sections are written into', async () => {
    for (const body of [
      { descriptionMarkdown: '## Deploying\n\nMerge to main.' },
      { description: BODY },
    ]) {
      const { service, expectNothingWritten } = setup();

      await expect(
        service.createPage(WORKSPACE, USER, {
          title: 'Deploying',
          kind: PageKindEnum.GENERATED,
          question: 'How do we deploy the server?',
          ...body,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expectNothingWritten();
    }
  });

  it('[KG-7.1] refuses a question for a page people write', async () => {
    const created = setup();
    await expect(
      created.service.createPage(WORKSPACE, USER, {
        title: 'Runbook',
        question: 'How do we deploy?',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    created.expectNothingWritten();

    const updated = setup(AUTHORED);
    await expect(
      updated.service.updatePage(AUTHORED.id, USER, {
        question: 'How do we deploy?',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    updated.expectNothingWritten();
  });

  it('[KG-7.1] never hands a page people wrote to the gardener', async () => {
    const { service, expectNothingWritten } = setup(AUTHORED);

    await expect(
      service.updatePage(AUTHORED.id, USER, { kind: PageKindEnum.GENERATED }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expectNothingWritten();
  });

  it('[KG-7.1] refuses an edit to a generated page’s body unless it is taken over by hand', async () => {
    const refused = setup(GENERATED);
    await expect(
      refused.service.updatePage(GENERATED.id, USER, {
        descriptionMarkdown: 'Hand edit.',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    refused.expectNothingWritten();

    // Renaming it is not an edit to what the gardener writes.
    const renamed = setup(GENERATED);
    await renamed.service.updatePage(GENERATED.id, USER, {
      title: 'Deploys',
    });
    expect(renamed.prisma.page.update.mock.calls[0][0].data).toMatchObject({
      title: 'Deploys',
    });
  });

  it('[KG-7.1] takes a generated page over by hand as a page people write, and records it', async () => {
    const { service, prisma, queue } = setup(GENERATED);

    await service.updatePage(GENERATED.id, USER, {
      kind: PageKindEnum.AUTHORED,
      descriptionMarkdown: 'Hand edit.',
    });

    expect(prisma.page.update.mock.calls[0][0].data).toMatchObject({
      kind: PageKindEnum.AUTHORED,
    });
    expect(prisma.pageHistory.create.mock.calls[0][0].data).toMatchObject({
      changes: {
        kind: { from: PageKindEnum.GENERATED, to: PageKindEnum.AUTHORED },
        body: true,
      },
      previousBody: BODY,
    });
    expect(queue.add).not.toHaveBeenCalled();

    // Taken over, it answers no question the gardener keeps.
    const withQuestion = setup(GENERATED);
    await expect(
      withQuestion.service.updatePage(GENERATED.id, USER, {
        kind: PageKindEnum.AUTHORED,
        question: 'Still?',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    withQuestion.expectNothingWritten();
  });

  it('[KG-7.1] leaves taking a generated page over to a person: an agent cannot, by its token or as its user', async () => {
    const byToken = setup(GENERATED);
    await expect(
      byToken.controller.updatePage(
        USER,
        RoleEnum.AGENT,
        { pageId: GENERATED.id },
        {
          kind: PageKindEnum.AUTHORED,
          descriptionMarkdown: 'An agent’s text.',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    byToken.expectNothingWritten();

    // Whatever the token, a user that is an agent or the gardener is not a
    // person.
    for (const type of ['Agent', 'System']) {
      const byUser = setup(GENERATED, type);
      await expect(
        byUser.controller.updatePage(
          USER,
          RoleEnum.USER,
          { pageId: GENERATED.id },
          {
            kind: PageKindEnum.AUTHORED,
            descriptionMarkdown: 'An agent’s text.',
          },
        ),
      ).rejects.toThrow('taken over by a person');
      byUser.expectNothingWritten();
    }

    // An agent's other edits to the page are as before.
    const renamed = setup(GENERATED, 'Agent');
    await renamed.controller.updatePage(
      USER,
      RoleEnum.AGENT,
      { pageId: GENERATED.id },
      { title: 'Deploys' },
    );
    expect(renamed.prisma.page.update).toHaveBeenCalled();
  });

  it('[KG-7.1] rebuilds a generated page asked a new question, without waiting for its evidence to change', async () => {
    const { service, prisma, queue } = setup(GENERATED);

    await service.updatePage(GENERATED.id, USER, {
      question: 'How do we roll back a deploy?',
    });

    expect(prisma.page.update.mock.calls[0][0].data).toMatchObject({
      question: 'How do we roll back a deploy?',
      watermark: null,
      evidenceHash: null,
    });
    expect(prisma.pageHistory.create.mock.calls[0][0].data).toMatchObject({
      changes: {
        question: {
          from: 'How do we deploy the server?',
          to: 'How do we roll back a deploy?',
        },
      },
    });
    // Never built: it is built now.
    expect(queue.add).toHaveBeenCalledWith(
      REFRESH_PAGE_JOB,
      { pageId: GENERATED.id },
      expect.not.objectContaining({ delay: expect.anything() }),
    );

    // Built two hours ago: the build waits out the rest of the workspace's
    // interval (six hours by default, three here), then runs.
    const now = Date.parse('2026-09-01T12:00:00Z');
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      for (const [preferences, left] of [
        [null, 4 * HOUR],
        [{ knowledge: { pageRefreshMinInterval: '3h' } }, HOUR],
        [{ knowledge: { pageRefreshMinInterval: '1h' } }, 0],
      ] as const) {
        const built = setup({
          ...GENERATED,
          refreshedAt: new Date(now - 2 * HOUR),
          workspace: { preferences },
        });
        await built.service.updatePage(GENERATED.id, USER, {
          question: 'How do we roll back a deploy?',
        });
        const options = built.queue.add.mock.calls[0][2] as { delay?: number };
        expect(options.delay).toBe(left ? left + 1_000 : undefined);
      }
    } finally {
      clock.mockRestore();
    }

    // The same question again is no change.
    const same = setup(GENERATED);
    await same.service.updatePage(GENERATED.id, USER, {
      question: ' How do we deploy the server? ',
    });
    expect(same.prisma.page.update.mock.calls[0][0].data).not.toHaveProperty(
      'watermark',
    );
    expect(same.prisma.pageHistory.create).not.toHaveBeenCalled();
    expect(same.queue.add).not.toHaveBeenCalled();

    const blank = setup(GENERATED);
    await expect(
      blank.service.updatePage(GENERATED.id, USER, { question: ' ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    blank.expectNothingWritten();
  });
});
