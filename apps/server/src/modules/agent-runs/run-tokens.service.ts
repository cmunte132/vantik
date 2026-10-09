import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { RoleEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { generatePersonalAccessToken } from 'common/authentication';

import { agentSettings } from 'modules/auth/agent-scope';
import { LoggerService } from 'modules/logger/logger.service';
import { UsersService } from 'modules/users/users.service';

/** The `type` of a token that exists for one run. */
export const RUN_TOKEN_TYPE = 'agent-run';

/** How long a run token outlives the run's deadline, if nothing revokes it. */
const TOKEN_GRACE_MS = 10 * 60 * 1000;

export interface MintedRunToken {
  value: string;
  expiresAt: Date;
}

/**
 * The credentials of a local run.
 *
 * A hosted run holds no Vantik credential at all. A local run cannot be built
 * that way: omp runs on the person's machine and calls Vantik itself. So the
 * run gets the narrowest credential that works: a token for the person's own
 * personal agent, valid for this run only. It expires with the run's deadline
 * and the run's terminal transition revokes it (`AgentRunsService`).
 *
 * The token value is returned once, to the caller that sends it to the
 * connector. It is never logged and never written to a run event.
 */
@Injectable()
export class RunTokensService {
  private readonly logger = new LoggerService('RunTokensService');

  constructor(
    private prisma: PrismaService,
    private users: UsersService,
  ) {}

  /**
   * The person's personal agent in this workspace, made on the first use.
   *
   * Only a live account counts: not hidden, not disabled, and not the
   * identity of a single issue.
   */
  async personalAgentFor(workspaceId: string, userId: string): Promise<string> {
    // One at a time per person and workspace: two delegations in the same
    // moment would otherwise each find nothing and each create an agent. The
    // lock is held to the end of this transaction, and a waiter re-reads after
    // getting it, so it sees the agent the first one made.
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`connector-agent:${workspaceId}:${userId}`}, 0))`;

        // Disabled means the person revoked it, so that one is not brought
        // back. Hidden alone is only clearing it from the list: still theirs.
        const memberships = await tx.usersOnWorkspaces.findMany({
          where: { workspaceId, role: RoleEnum.AGENT, status: 'ACTIVE' },
          select: { userId: true, settings: true },
        });

        const existing = memberships.find((membership) => {
          const settings = agentSettings(membership.settings);

          return (
            settings.ownership === 'personal' &&
            settings.ownerUserId === userId &&
            !settings.ephemeral &&
            !settings.disabledAt
          );
        });

        return (
          existing?.userId ?? this.createPersonalAgent(workspaceId, userId)
        );
      },
      { timeout: 20_000 },
    );
  }

  private async createPersonalAgent(
    workspaceId: string,
    userId: string,
  ): Promise<string> {
    const person = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { fullname: true, username: true },
    });
    const name = `${person?.fullname || person?.username || 'My'} · omp`;

    const created = await this.users.createAgentAccount(
      workspaceId,
      name,
      userId,
      'personal',
    );

    // Creating a personal agent also mints its standing token, shown once to
    // whoever asked. Nobody asked here, and a credential nobody holds is one
    // that can only leak: end it now. The agent works with run tokens.
    await this.prisma.personalAccessToken.updateMany({
      where: { workspaceId, userId: created.id, type: 'agent', deleted: null },
      data: { deleted: new Date() },
    });

    // Marked so Settings → Agents lists it as live. That list reads "no live
    // standing token" as revoked, and this agent holds none by design: it
    // works on run tokens.
    const membership = await this.prisma.usersOnWorkspaces.findFirst({
      where: { workspaceId, userId: created.id },
      select: { settings: true },
    });
    const settings = (membership?.settings ?? {}) as Record<string, unknown>;
    await this.prisma.usersOnWorkspaces.update({
      where: { userId_workspaceId: { userId: created.id, workspaceId } },
      data: {
        settings: {
          ...settings,
          agent: {
            ...((settings.agent ?? {}) as Record<string, unknown>),
            connector: true,
          },
        },
      },
    });

    return created.id;
  }

  /** A token for one run, as the person's personal agent. */
  async mint(input: {
    runId: string;
    workspaceId: string;
    agentUserId: string;
    deadlineAt: Date;
  }): Promise<MintedRunToken> {
    const value = generatePersonalAccessToken();
    const expiresAt = new Date(input.deadlineAt.getTime() + TOKEN_GRACE_MS);

    await this.prisma.personalAccessToken.create({
      data: {
        name: `Run ${input.runId}`,
        userId: input.agentUserId,
        workspaceId: input.workspaceId,
        tokenHash: createHash('sha256').update(value).digest('hex'),
        type: RUN_TOKEN_TYPE,
        agentRunId: input.runId,
        expiresAt,
      },
    });

    return { value, expiresAt };
  }

  /** Ends every live token of a run. Safe to call more than once. */
  async revoke(runId: string): Promise<void> {
    try {
      await this.prisma.personalAccessToken.updateMany({
        where: { agentRunId: runId, deleted: null },
        data: { deleted: new Date() },
      });
    } catch (error) {
      this.logger.error({
        message: `The tokens of run ${runId} were not revoked: ${error}`,
        where: 'RunTokensService.revoke',
        error: error instanceof Error ? error : undefined,
      });
    }
  }
}
