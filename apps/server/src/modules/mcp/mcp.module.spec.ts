import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaService } from 'nestjs-prisma';

import { UsersService } from 'modules/users/users.service';

import { McpThrottleGuard } from './mcp-throttle.guard';
import { McpController } from './mcp.controller';

/**
 * The endpoint's guards are resolved out of this module, so a provider it does
 * not supply fails at request time rather than at boot. AuthGuard looks
 * UsersService up through ModuleRef, which searches this module's injector.
 */
describe('the MCP endpoint wiring', () => {
  async function build() {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }])],
      controllers: [McpController],
      providers: [
        UsersService,
        // Global in the real app, so they are stood in for rather than imported.
        { provide: PrismaService, useValue: {} },
        {
          provide: ConfigService,
          useValue: { get: (): undefined => undefined },
        },
      ],
    }).compile();

    await moduleRef.init();
    return moduleRef;
  }

  it('can resolve the UsersService that AuthGuard reaches for', async () => {
    const moduleRef = await build();

    await expect(moduleRef.resolve(UsersService)).resolves.toBeInstanceOf(
      UsersService,
    );

    await moduleRef.close();
  });

  it('guards the endpoint with the MCP budget, not the app-wide one', async () => {
    const moduleRef = await build();

    const guard = new McpThrottleGuard(
      [{ ttl: 60_000, limit: 10 }],
      { increment: jest.fn() } as never,
      new Reflector(),
    );
    await guard.onModuleInit();

    expect(guard).toBeInstanceOf(ThrottlerGuard);
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (guard as any).throttlers[0],
    ).toMatchObject({ name: 'mcp' });

    await moduleRef.close();
  });
});
