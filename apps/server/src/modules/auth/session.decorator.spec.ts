import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AuthSessionContext, createAuthSessionContext } from './auth.interface';
import { Workspace } from './session.decorator';

@Controller('scope')
class ScopeController {
  @Get()
  read(@Workspace() workspaceId: string) {
    return { workspaceId };
  }
}

describe('Workspace session boundary', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  it('rejects an account without workspace access before the handler receives an empty scope', async () => {
    const session = createAuthSessionContext({ appUserId: 'account-1' });
    const module = await Test.createTestingModule({
      controllers: [ScopeController],
    }).compile();
    app = module.createNestApplication();
    app.use((req: { session?: AuthSessionContext }, _res: unknown, next: () => void) => {
      req.session = session;
      next();
    });
    await app.init();

    await request(app.getHttpServer()).get('/scope').expect(401);
  });
});
