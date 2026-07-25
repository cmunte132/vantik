import { ForbiddenException } from '@nestjs/common';
import { DEFAULT_AGENT_SCOPES, RoleEnum } from '@vantikhq/types';

import {
  agentSettings,
  requiredScopeFor,
  sanitizeScopes,
  SKIP_AGENT_SCOPE,
} from './agent-scope';
import { AgentScopeGuard } from './agent-scope.guard';

describe('requiredScopeFor', () => {
  it('reads safe methods as reads', () => {
    expect(requiredScopeFor('GET')).toBe('read');
    expect(requiredScopeFor('head')).toBe('read');
    expect(requiredScopeFor('OPTIONS')).toBe('read');
  });

  it('reads DELETE as its own scope', () => {
    expect(requiredScopeFor('DELETE')).toBe('delete');
  });

  it('reads everything else as a write', () => {
    expect(requiredScopeFor('POST')).toBe('write');
    expect(requiredScopeFor('PUT')).toBe('write');
    expect(requiredScopeFor('PATCH')).toBe('write');
  });
});

describe('agentSettings', () => {
  it('reads what was granted, and who owns the agent', () => {
    expect(
      agentSettings({
        agent: {
          ownership: 'workspace',
          ownerUserId: null,
          scopes: ['read', 'delete'],
        },
      }),
    ).toEqual({
      ownership: 'workspace',
      ownerUserId: null,
      scopes: ['read', 'delete'],
    });
  });

  it('gives an agent from before scopes existed the default, not everything', () => {
    expect(agentSettings({ agent: { ownership: 'personal' } }).scopes).toEqual(
      DEFAULT_AGENT_SCOPES,
    );
    expect(agentSettings(null)).toEqual({
      ownership: 'personal',
      ownerUserId: null,
      scopes: DEFAULT_AGENT_SCOPES,
    });
  });

  it('drops values it does not recognise', () => {
    expect(
      agentSettings({ agent: { scopes: ['read', 'sudo'] } }).scopes,
    ).toEqual(['read']);
  });
});

describe('sanitizeScopes', () => {
  it('defaults when nothing is asked for', () => {
    expect(sanitizeScopes(undefined)).toEqual(DEFAULT_AGENT_SCOPES);
  });

  it('drops unknown scopes and duplicates', () => {
    expect(sanitizeScopes(['write', 'write', 'sudo'])).toEqual(['write']);
  });

  it('defaults rather than granting nothing', () => {
    expect(sanitizeScopes([])).toEqual(DEFAULT_AGENT_SCOPES);
    expect(sanitizeScopes(['sudo'])).toEqual(DEFAULT_AGENT_SCOPES);
  });
});

describe('AgentScopeGuard', () => {
  const AGENT_TOKEN = 'tg_pat_agent';

  function context(method: string, authorization?: string) {
    return {
      getType: () => 'http',
      getHandler: (): undefined => undefined,
      getClass: (): undefined => undefined,
      switchToHttp: () => ({
        getRequest: () => ({ method, headers: { authorization } }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  function guard(
    settings: unknown,
    options: { skip?: boolean; declared?: string; role?: string } = {},
  ) {
    const prisma = {
      personalAccessToken: {
        findFirst: jest.fn().mockResolvedValue({
          userId: 'agent-1',
          workspaceId: 'ws-1',
          user: {
            authIdentities: [{ supertokensUserId: 'st-1' }],
            usersOnWorkspaces: [
              {
                workspaceId: 'ws-1',
                role: options.role ?? RoleEnum.AGENT,
                settings,
              },
            ],
          },
        }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const reflector = {
      getAllAndOverride: (key: string) =>
        key === SKIP_AGENT_SCOPE ? (options.skip ?? false) : options.declared,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    return new AgentScopeGuard(prisma, reflector);
  }

  it('lets an agent read and write with the default scopes', async () => {
    const subject = guard({ agent: { scopes: ['read', 'write'] } });

    await expect(
      subject.canActivate(context('GET', `Bearer ${AGENT_TOKEN}`)),
    ).resolves.toBe(true);
    await expect(
      subject.canActivate(context('POST', `Bearer ${AGENT_TOKEN}`)),
    ).resolves.toBe(true);
  });

  it('refuses a delete the agent was not granted', async () => {
    const subject = guard({ agent: { scopes: ['read', 'write'] } });

    await expect(
      subject.canActivate(context('DELETE', `Bearer ${AGENT_TOKEN}`)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a delete once it is granted', async () => {
    const subject = guard({ agent: { scopes: ['read', 'write', 'delete'] } });

    await expect(
      subject.canActivate(context('DELETE', `Bearer ${AGENT_TOKEN}`)),
    ).resolves.toBe(true);
  });

  it('refuses a write for a read-only agent', async () => {
    const subject = guard({ agent: { scopes: ['read'] } });

    await expect(
      subject.canActivate(context('POST', `Bearer ${AGENT_TOKEN}`)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('leaves people alone', async () => {
    const subject = guard({ agent: { scopes: ['read'] } });

    // A cookie session carries no token for the guard to resolve.
    await expect(subject.canActivate(context('DELETE'))).resolves.toBe(true);
    await expect(
      subject.canActivate(context('DELETE', 'Bearer some.jwt.value')),
    ).resolves.toBe(true);
  });

  it("leaves a person's own access token alone", async () => {
    // Same kind of credential, but the membership behind it is not an agent's,
    // so none of this applies to it.
    const subject = guard(
      { agent: { scopes: ['read'] } },
      { role: RoleEnum.ADMIN },
    );

    await expect(
      subject.canActivate(context('DELETE', `Bearer ${AGENT_TOKEN}`)),
    ).resolves.toBe(true);
  });

  it('lets a route declare a read that arrives as a POST', async () => {
    // POST /v1/issues/filter is the board itself; on method alone a read-only
    // agent would be locked out of the one thing it exists to do.
    const subject = guard(
      { agent: { scopes: ['read'] } },
      { declared: 'read' },
    );

    await expect(
      subject.canActivate(context('POST', `Bearer ${AGENT_TOKEN}`)),
    ).resolves.toBe(true);
  });

  it('still refuses a declared scope the agent lacks', async () => {
    const subject = guard(
      { agent: { scopes: ['read'] } },
      { declared: 'delete' },
    );

    await expect(
      subject.canActivate(context('GET', `Bearer ${AGENT_TOKEN}`)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('skips routes whose method does not describe the work', async () => {
    const subject = guard({ agent: { scopes: ['read'] } }, { skip: true });

    await expect(
      subject.canActivate(context('POST', `Bearer ${AGENT_TOKEN}`)),
    ).resolves.toBe(true);
  });
});
