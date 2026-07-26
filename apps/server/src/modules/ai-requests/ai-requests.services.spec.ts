import { createServer, type Server } from 'node:http';

import AIRequestsService from './ai-requests.services';

/**
 * Drives the service against a stub OpenAI-compatible endpoint, so what it puts
 * on the wire is asserted rather than assumed: the path, the key, and which
 * concrete model each role reaches.
 */
describe('AIRequestsService against an OpenAI-compatible endpoint', () => {
  let server: Server;
  let seen: Array<{ path: string; auth?: string; model: string }>;
  let records: Array<{ llmModel: string }>;
  let service: AIRequestsService;

  const env = process.env;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        seen.push({
          path: req.url,
          auth: req.headers.authorization,
          model: body.model,
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-stub',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'stub answer' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
  });

  afterAll(() => {
    server.close();
    process.env = env;
  });

  beforeEach(() => {
    seen = [];
    records = [];

    const port = (server.address() as { port: number }).port;
    process.env = {
      ...env,
      LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
      LLM_API_KEY: 'stub-key',
      LLM_MODEL_FAST: 'stub/fast-model',
      LLM_MODEL_SMART: 'stub/smart-model',
    };

    const prisma = {
      aIRequest: {
        create: async ({ data }: { data: { llmModel: string } }) => {
          records.push(data);
        },
      },
    };

    service = new AIRequestsService(prisma as never);
  });

  const ask = (llmModel: string) =>
    service.getLLMRequest(
      { messages: [{ role: 'user', content: 'hi' }], llmModel, model: 'Test' },
      'ws-1',
    );

  it('serves each role with the model that role is configured for', async () => {
    await ask('fast');
    await ask('smart');

    expect(seen).toEqual([
      {
        path: '/v1/chat/completions',
        auth: 'Bearer stub-key',
        model: 'stub/fast-model',
      },
      {
        path: '/v1/chat/completions',
        auth: 'Bearer stub-key',
        model: 'stub/smart-model',
      },
    ]);
  });

  // Actions deploy to trigger.dev on their own schedule, so a current server
  // has to keep serving requests from action code shipped long before it.
  it('still serves a legacy model id from an older deployed action', async () => {
    await ask('gpt-3.5-turbo');
    await ask('gpt-4o');

    expect(seen.map((request) => request.model)).toEqual([
      'stub/fast-model',
      'stub/smart-model',
    ]);
  });

  it('records the model that answered, not the role that was asked for', async () => {
    await ask('fast');

    expect(records).toEqual([
      expect.objectContaining({ llmModel: 'stub/fast-model' }),
    ]);
  });

  // The provider switch this replaced fell back to a local model whenever it
  // could not resolve one, so a half-configured install answered with something
  // nobody had chosen and said nothing about it.
  it('fails naming the unset variable instead of falling back', async () => {
    delete process.env.LLM_MODEL_SMART;

    await expect(ask('smart')).rejects.toThrow('LLM_MODEL_SMART');
    expect(seen).toHaveLength(0);
  });
});
