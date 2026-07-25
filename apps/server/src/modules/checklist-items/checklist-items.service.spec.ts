import ChecklistItemsService from './checklist-items.service';

/**
 * The Definition of Done rules that are not obvious from reading the calls:
 * where a new item lands in the order, and when ticking one rewrites who ticked
 * it. Both are easy to break silently — a lost `completedById` or a reversed
 * list reads as data being wrong rather than as code being wrong.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function buildPrisma(overrides: any = {}) {
  return {
    checklistItem: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((args: any) => args.data),
      update: jest.fn().mockImplementation((args: any) => args.data),
      ...overrides,
    },
  };
}

function serviceWith(prisma: any) {
  return new ChecklistItemsService(prisma);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('ChecklistItemsService.createChecklistItem', () => {
  it('puts the first item at the front of an empty list', async () => {
    const prisma = buildPrisma();

    await serviceWith(prisma).createChecklistItem(
      { issueId: 'issue-1' },
      'user-1',
      { body: 'Ships behind a flag' },
    );

    expect(prisma.checklistItem.create.mock.calls[0][0].data.sortOrder).toBe(1);
  });

  it('puts a new item after the last one', async () => {
    const prisma = buildPrisma({
      findFirst: jest.fn().mockResolvedValue({ sortOrder: 7 }),
    });

    await serviceWith(prisma).createChecklistItem(
      { issueId: 'issue-1' },
      'user-1',
      { body: 'Has a test' },
    );

    expect(prisma.checklistItem.create.mock.calls[0][0].data.sortOrder).toBe(8);
  });

  it('honours a sortOrder of zero rather than reading it as absent', async () => {
    const prisma = buildPrisma({
      findFirst: jest.fn().mockResolvedValue({ sortOrder: 7 }),
    });

    await serviceWith(prisma).createChecklistItem(
      { issueId: 'issue-1' },
      'user-1',
      { body: 'Goes first', sortOrder: 0 },
    );

    expect(prisma.checklistItem.create.mock.calls[0][0].data.sortOrder).toBe(0);
  });

  it('leaves a new item unticked, and records nobody as having ticked it', async () => {
    const prisma = buildPrisma();

    await serviceWith(prisma).createChecklistItem(
      { issueId: 'issue-1' },
      'user-1',
      { body: 'Has a test' },
    );

    const { data } = prisma.checklistItem.create.mock.calls[0][0];
    expect(data.completed).toBe(false);
    expect(data.completedAt).toBeUndefined();
    expect(data.completedById).toBeUndefined();
  });

  it('records who ticked an item created already done', async () => {
    const prisma = buildPrisma();

    await serviceWith(prisma).createChecklistItem(
      { issueId: 'issue-1' },
      'user-1',
      { body: 'Already true', completed: true },
    );

    const { data } = prisma.checklistItem.create.mock.calls[0][0];
    expect(data.completed).toBe(true);
    expect(data.completedById).toBe('user-1');
    expect(data.completedAt).toBeInstanceOf(Date);
  });
});

describe('ChecklistItemsService.updateChecklistItem', () => {
  it('records who ticked an item when it becomes done', async () => {
    const prisma = buildPrisma({
      findUnique: jest.fn().mockResolvedValue({ completed: false }),
    });

    await serviceWith(prisma).updateChecklistItem(
      { checklistItemId: 'item-1' },
      'user-2',
      { completed: true },
    );

    const { data } = prisma.checklistItem.update.mock.calls[0][0];
    expect(data.completed).toBe(true);
    expect(data.completedById).toBe('user-2');
    expect(data.completedAt).toBeInstanceOf(Date);
  });

  it('clears the provenance when an item is unticked', async () => {
    const prisma = buildPrisma({
      findUnique: jest.fn().mockResolvedValue({ completed: true }),
    });

    await serviceWith(prisma).updateChecklistItem(
      { checklistItemId: 'item-1' },
      'user-2',
      { completed: false },
    );

    const { data } = prisma.checklistItem.update.mock.calls[0][0];
    expect(data.completed).toBe(false);
    expect(data.completedById).toBeNull();
    expect(data.completedAt).toBeNull();
  });

  it('does not steal attribution when a body edit leaves it ticked', async () => {
    const prisma = buildPrisma({
      findUnique: jest.fn().mockResolvedValue({ completed: true }),
    });

    await serviceWith(prisma).updateChecklistItem(
      { checklistItemId: 'item-1' },
      'someone-else',
      { body: 'Reworded', completed: true },
    );

    const { data } = prisma.checklistItem.update.mock.calls[0][0];
    expect(data.body).toBe('Reworded');
    // The state did not change, so who ticked it is left exactly as it was.
    expect(data).not.toHaveProperty('completedById');
    expect(data).not.toHaveProperty('completedAt');
  });

  it('leaves completion alone entirely when the edit does not mention it', async () => {
    const prisma = buildPrisma();

    await serviceWith(prisma).updateChecklistItem(
      { checklistItemId: 'item-1' },
      'user-2',
      { body: 'Reworded' },
    );

    const { data } = prisma.checklistItem.update.mock.calls[0][0];
    expect(data).not.toHaveProperty('completed');
    // Nothing to look up: the checked state is not in play.
    expect(prisma.checklistItem.findUnique).not.toHaveBeenCalled();
  });

  it('writes only the fields the DTO declares', async () => {
    const prisma = buildPrisma();

    await serviceWith(prisma).updateChecklistItem(
      { checklistItemId: 'item-1' },
      'user-2',
      // Anything else the caller put in the body survives the global
      // ValidationPipe, which does not whitelist, so it must not reach Prisma:
      // issueId would move the item to another workspace's issue.
      {
        body: 'Reworded',
        issueId: 'issue-in-another-workspace',
        deleted: null,
        issue: { update: { title: 'pwned' } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    );

    const { data } = prisma.checklistItem.update.mock.calls[0][0];
    expect(data).toEqual({ body: 'Reworded', updatedById: 'user-2' });
  });
});

describe('ChecklistItemsService.deleteChecklistItem', () => {
  it('soft deletes, so replication can drive removal off the timestamp', async () => {
    const prisma = buildPrisma();

    await serviceWith(prisma).deleteChecklistItem(
      { checklistItemId: 'item-1' },
      'user-2',
    );

    const { data } = prisma.checklistItem.update.mock.calls[0][0];
    expect(data.deleted).toBeInstanceOf(Date);
    expect(data.updatedById).toBe('user-2');
  });
});

describe('ChecklistItemsService.getChecklistItems', () => {
  it('reads one issue’s live items in list order', async () => {
    const prisma = buildPrisma();

    await serviceWith(prisma).getChecklistItems({ issueId: 'issue-1' });

    expect(prisma.checklistItem.findMany).toHaveBeenCalledWith({
      where: { issueId: 'issue-1', deleted: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  });
});
