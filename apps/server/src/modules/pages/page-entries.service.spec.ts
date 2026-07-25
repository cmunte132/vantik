/**
 * The write gate on the knowledge bank.
 *
 * Everything here is a *mechanical* limit that applies to every caller — the
 * REST API, the CLI, agent-core and the MCP tools alike. The curation opinion
 * lives only in the MCP tool layer; what is tested here is arithmetic and state
 * machine, which is what has to hold when a model that ignores tool
 * descriptions is pointed at the endpoint.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PageEntryPolicyEnum, PageEntryStatusEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import PageEntriesService from './page-entries.service';
import { PROPOSED_ENTRY_BUDGET, WriterIdentity } from './pages.interface';

const AGENT: WriterIdentity = { userId: 'agent-1', tokenId: 'token-1' };
const HUMAN: WriterIdentity = { userId: 'human-1', tokenId: null };

interface Options {
  policy?: PageEntryPolicyEnum;
  outstanding?: number;
  userType?: 'Agent' | 'User';
  entryStatus?: PageEntryStatusEnum;
  supersededBy?: { id: string } | null;
}

function buildService({
  policy = PageEntryPolicyEnum.CURATED,
  outstanding = 0,
  userType = 'Agent',
  entryStatus = PageEntryStatusEnum.PROPOSED,
  supersededBy = null,
}: Options = {}) {
  const created: unknown[] = [];

  const prisma = {
    page: {
      findFirst: jest.fn(() =>
        Promise.resolve({
          id: 'page-1',
          title: 'Deployment',
          entryPolicy: policy,
        }),
      ),
    },
    user: {
      findUnique: jest.fn(() => Promise.resolve({ type: userType })),
    },
    pageEntry: {
      findMany: jest.fn(() =>
        Promise.resolve(
          Array.from({ length: outstanding }, (_, index) => ({
            id: `existing-${index}`,
            content: `a fact ${index}`,
            status: PageEntryStatusEnum.PROPOSED,
          })),
        ),
      ),
      findFirst: jest.fn(() =>
        Promise.resolve({ status: entryStatus, supersededBy }),
      ),
      create: jest.fn(({ data }) => {
        created.push(data);
        return { id: 'entry-new', ...data };
      }),
      update: jest.fn(({ where, data }) => ({ id: where.id, ...data })),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    // The transaction double runs whatever the service handed it, so a create
    // that was never reached stays absent from `created`.
    $transaction: jest.fn((operations: unknown[]) => Promise.resolve(operations)),
  } as unknown as PrismaService;

  return { service: new PageEntriesService(prisma), prisma, created };
}

describe('entry policy', () => {
  it('refuses an agent append to a LOCKED page and creates nothing', async () => {
    const { service, prisma } = buildService({
      policy: PageEntryPolicyEnum.LOCKED,
    });

    await expect(
      service.createEntry('page-1', AGENT, { content: 'a fact' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.pageEntry.create).not.toHaveBeenCalled();
  });

  it('still lets a human append to a LOCKED page', async () => {
    const { service } = buildService({
      policy: PageEntryPolicyEnum.LOCKED,
      userType: 'User',
    });

    await expect(
      service.createEntry('page-1', HUMAN, { content: 'a fact' }),
    ).resolves.toBeDefined();
  });

  it('does not enforce the budget on an OPEN page', async () => {
    const { service } = buildService({
      policy: PageEntryPolicyEnum.OPEN,
      outstanding: PROPOSED_ENTRY_BUDGET + 5,
    });

    await expect(
      service.createEntry('page-1', AGENT, { content: 'a fact' }),
    ).resolves.toBeDefined();
  });
});

describe('proposed-entry budget', () => {
  it('refuses once the token is at the cap, and creates nothing', async () => {
    const { service, prisma } = buildService({
      outstanding: PROPOSED_ENTRY_BUDGET,
    });

    await expect(
      service.createEntry('page-1', AGENT, { content: 'a fact' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.pageEntry.create).not.toHaveBeenCalled();
  });

  it('names the entries in the way, so the refusal is actionable', async () => {
    const { service } = buildService({ outstanding: PROPOSED_ENTRY_BUDGET });

    // A dead end teaches an agent nothing and it retries the same append. The
    // error has to say which entries to consolidate or supersede.
    await expect(
      service.createEntry('page-1', AGENT, { content: 'a fact' }),
    ).rejects.toThrow(/existing-0/);
  });

  it('counts per token, so one harness cannot spend another’s allowance', async () => {
    const { service, prisma } = buildService({ outstanding: 0 });

    await service.createEntry('page-1', AGENT, { content: 'a fact' });

    const { where } = (prisma.pageEntry.findMany as jest.Mock).mock.calls[0][0];
    expect(where.sourceTokenId).toBe('token-1');
  });
});

describe('provenance and supersede', () => {
  it('records who asserted the fact, on which session and token', async () => {
    const { service, created } = buildService();

    await service.createEntry('page-1', AGENT, {
      content: 'Redis is only a cache here',
      scope: 'apps/server',
      sourceSession: 'session-abc',
    });

    expect(created[0]).toMatchObject({
      sourceUserId: 'agent-1',
      sourceTokenId: 'token-1',
      sourceSession: 'session-abc',
      scope: 'apps/server',
      status: PageEntryStatusEnum.PROPOSED,
    });
  });

  it('lands an agent’s write in the inbox even when it asks for STANDING', async () => {
    const { service, created } = buildService();

    await service.createEntry('page-1', AGENT, {
      content: 'a fact',
      standing: true,
    });

    // Self-approval would make the review gate optional, which is the same as
    // not having one.
    expect(created[0]).toMatchObject({
      status: PageEntryStatusEnum.PROPOSED,
    });
  });

  it('refuses to supersede an entry that already has a replacement', async () => {
    const { service, prisma } = buildService({
      supersededBy: { id: 'entry-newer' },
    });

    await expect(
      service.createEntry('page-1', AGENT, {
        content: 'a fact',
        supersedesId: 'entry-old',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.pageEntry.create).not.toHaveBeenCalled();
  });
});

describe('status transitions', () => {
  it('refuses to revive a CONSOLIDATED entry', async () => {
    const { service } = buildService({
      entryStatus: PageEntryStatusEnum.CONSOLIDATED,
    });

    // It is already in the page body; serving it again duplicates the fact.
    await expect(
      service.updateEntry('entry-1', 'human-1', {
        status: PageEntryStatusEnum.STANDING,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to revive a SUPERSEDED entry', async () => {
    const { service } = buildService({
      entryStatus: PageEntryStatusEnum.SUPERSEDED,
    });

    await expect(
      service.updateEntry('entry-1', 'human-1', {
        status: PageEntryStatusEnum.STANDING,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to push an entry back into the inbox', async () => {
    const { service } = buildService({
      entryStatus: PageEntryStatusEnum.STANDING,
    });

    await expect(
      service.updateEntry('entry-1', 'human-1', {
        status: PageEntryStatusEnum.PROPOSED,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a proposed entry as standing', async () => {
    const { service } = buildService({
      entryStatus: PageEntryStatusEnum.PROPOSED,
    });

    await expect(
      service.updateEntry('entry-1', 'human-1', {
        status: PageEntryStatusEnum.STANDING,
      }),
    ).resolves.toBeDefined();
  });

  it('stamps who verified an entry rather than trusting the flag alone', async () => {
    const { service, prisma } = buildService({
      entryStatus: PageEntryStatusEnum.STANDING,
    });

    await service.updateEntry('entry-1', 'human-1', { verified: true });

    const { data } = (prisma.pageEntry.update as jest.Mock).mock.calls[0][0];
    expect(data.verifiedByUserId).toBe('human-1');
    expect(data.verifiedAt).toBeInstanceOf(Date);
  });
});

describe('serving and decay', () => {
  it('increments retrieval counts atomically', async () => {
    const { service, prisma } = buildService();

    await service.recordServed(['entry-1', 'entry-2']);

    const { data } = (prisma.pageEntry.updateMany as jest.Mock).mock.calls[0][0];
    // A read-then-write would lose one of two concurrent searches, and this
    // number decides what survives the decay pass.
    expect(data.retrievalCount).toEqual({ increment: 1 });
    expect(data.lastServedAt).toBeInstanceOf(Date);
  });

  it('leaves verified standing entries alone even when nothing reads them', async () => {
    const { service, prisma } = buildService();

    await service.runDecay('workspace-1');

    const standingPass = (prisma.pageEntry.updateMany as jest.Mock).mock
      .calls[1][0];
    // Retrieval count is a proxy for "worth keeping"; a human vouching for it
    // is the real thing, and outranks the proxy.
    expect(standingPass.where.verifiedAt).toBeNull();
    expect(standingPass.where.retrievalCount).toBe(0);
  });
});
