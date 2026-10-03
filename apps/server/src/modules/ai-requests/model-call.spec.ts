import { createServer, type Server } from 'node:http';

import { LoggerService } from 'modules/logger/logger.service';

import { generateModelText } from './model-call';

/**
 * These tests send calls to a stub OpenAI-compatible endpoint. They make sure
 * that each call writes a log line that names its feature and its model, and
 * that a failed call writes an error line.
 */
describe('generateModelText', () => {
  let server: Server;
  let status: number;

  const env = process.env;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        res.writeHead(status, { 'Content-Type': 'application/json' });

        if (status !== 200) {
          res.end(JSON.stringify({ error: { message: 'bad request' } }));
          return;
        }

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
            usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
          }),
        );
      });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );

    const port = (server.address() as { port: number }).port;
    process.env = {
      ...env,
      LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
      LLM_API_KEY: 'stub-key',
      LLM_MODEL: 'stub/default-model',
      LLM_MODEL_DECISIONS: 'stub/decisions-model',
    };
  });

  afterAll(() => {
    server.close();
    process.env = env;
  });

  let info: jest.SpyInstance;
  let error: jest.SpyInstance;
  let debug: jest.SpyInstance;

  beforeEach(() => {
    status = 200;
    info = jest.spyOn(LoggerService.prototype, 'info').mockImplementation();
    error = jest.spyOn(LoggerService.prototype, 'error').mockImplementation();
    debug = jest.spyOn(LoggerService.prototype, 'debug').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('logs the feature, the model, the duration and the tokens of a call', async () => {
    const answer = await generateModelText({
      purpose: 'triage.pair',
      tier: 'decisions',
      system: 'be brief',
      prompt: 'hello',
    });

    expect(answer).toEqual({
      text: 'stub answer',
      model: 'stub/decisions-model',
    });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toMatchObject({
      message: expect.stringMatching(
        /^triage\.pair: stub\/decisions-model answered in \d+ ms$/,
      ),
      payload: {
        purpose: 'triage.pair',
        role: 'decisions',
        model: 'stub/decisions-model',
        durationMs: expect.any(Number),
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
        finishReason: 'stop',
      },
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('keeps the prompt and the answer for the debug level', async () => {
    await generateModelText({ purpose: 'page.refresh', prompt: 'hello' });

    expect(debug.mock.calls[0][0].payload).toMatchObject({
      purpose: 'page.refresh',
      model: 'stub/default-model',
      prompt: 'hello',
      answer: 'stub answer',
    });
  });

  it('logs a failed call as an error and throws it again', async () => {
    status = 400;

    await expect(
      generateModelText({ purpose: 'citation.judge', prompt: 'hello' }),
    ).rejects.toThrow();

    expect(info).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatchObject({
      message: expect.stringMatching(
        /^citation\.judge: stub\/default-model failed after \d+ ms$/,
      ),
      payload: { purpose: 'citation.judge', model: 'stub/default-model' },
      error: expect.any(Error),
    });
  });

  it('logs a call that has no model configured', async () => {
    process.env.LLM_MODEL = '';

    try {
      await expect(
        generateModelText({ purpose: 'triage.accept', prompt: 'hello' }),
      ).rejects.toThrow('LLM_MODEL is not set');
    } finally {
      process.env.LLM_MODEL = 'stub/default-model';
    }

    expect(error.mock.calls[0][0]).toMatchObject({
      message: expect.stringMatching(/^triage\.accept: no model failed/),
      payload: { purpose: 'triage.accept', model: null },
    });
  });
});
