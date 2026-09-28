import { Test } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import { Client as TypesenseClient } from 'typesense';

import { CacheService } from 'modules/cache/cache.service';
import { UsersService } from 'modules/users/users.service';

import { AgentHooksController } from './agent-hooks.controller';
import { AgentHooksModule } from './agent-hooks.module';
import { AgentHooksService } from './agent-hooks.service';

/**
 * A provider the module does not supply fails at boot, or — for AuthGuard,
 * which looks UsersService up through ModuleRef — at the first request. Both
 * are caught here instead.
 */
describe('the agent hooks wiring', () => {
  it('builds the controller, its service, and what AuthGuard reaches for', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AgentHooksModule],
    })
      // The real one opens a redis connection on construction.
      .overrideProvider(CacheService)
      .useValue({})
      .overrideProvider(TypesenseClient)
      .useValue({})
      // Global in the real app, so it is stood in for rather than imported.
      .useMocker((token) => (token === PrismaService ? {} : undefined))
      .compile();

    expect(moduleRef.get(AgentHooksController)).toBeInstanceOf(
      AgentHooksController,
    );
    expect(moduleRef.get(AgentHooksService)).toBeInstanceOf(AgentHooksService);
    await expect(moduleRef.resolve(UsersService)).resolves.toBeInstanceOf(
      UsersService,
    );

    await moduleRef.close();
  });
});
