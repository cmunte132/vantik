import { SessionContainer } from 'supertokens-node/recipe/session';

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { CreateAgentDto } from './users.interface';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

function buildController() {
  const users = {
    createAgentAccount: jest.fn().mockResolvedValue({ id: 'agent-1' }),
  } as unknown as UsersService;

  const session = {
    getAccessTokenPayload: () => ({ appUserId: 'admin-1' }),
  } as unknown as SessionContainer;

  return { controller: new UsersController(users), users, session };
}

/**
 * The service has taken an ownership since it was written, and writes
 * `ownerUserId: null` for a workspace agent. The controller was the missing
 * half: it passed the literal 'personal' on every call, so the capability was
 * unreachable over the API no matter what a caller sent.
 */
describe('UsersController.createAgentAccount', () => {
  it('passes the requested ownership through to the service', async () => {
    const { controller, users, session } = buildController();

    await controller.createAgentAccount('ws-1', session, {
      name: 'Release Bot',
      ownership: 'workspace',
    });

    expect(users.createAgentAccount).toHaveBeenCalledWith(
      'ws-1',
      'Release Bot',
      'admin-1',
      'workspace',
      expect.anything(),
      undefined,
    );
  });

  // A caller that predates the field must keep the behaviour it had.
  it('defaults to a personal agent when no ownership is sent', async () => {
    const { controller, users, session } = buildController();

    await controller.createAgentAccount('ws-1', session, {
      name: 'My Agent',
    });

    expect(users.createAgentAccount).toHaveBeenCalledWith(
      'ws-1',
      'My Agent',
      'admin-1',
      'personal',
      expect.anything(),
      undefined,
    );
  });
});

describe('CreateAgentDto ownership validation', () => {
  it.each(['personal', 'workspace'])('accepts %s', (ownership) => {
    const dto = plainToInstance(CreateAgentDto, { name: 'A', ownership });

    expect(validateSync(dto)).toHaveLength(0);
  });

  it('rejects an ownership that is neither', () => {
    const dto = plainToInstance(CreateAgentDto, {
      name: 'A',
      ownership: 'everyone',
    });

    const errors = validateSync(dto);

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('ownership');
  });

  it('accepts the field being absent', () => {
    const dto = plainToInstance(CreateAgentDto, { name: 'A' });

    expect(validateSync(dto)).toHaveLength(0);
  });
});
