import { askPerson, AskOptions, parseAsked } from './vantik-extension';

const QUESTIONS = [{ id: 'q', prompt: 'Which one?' }];

function setup(files: Record<string, string> = {}, overrides = {}) {
  let clock = 0;
  const queued: unknown[] = [];
  const options: AskOptions = {
    queue: (item) => queued.push(item),
    readAnswer: (id) => files[id] ?? null,
    waitMs: 10_000,
    pollMs: 2_000,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    newId: () => 'ask-1',
    ...overrides,
  };
  return { options, queued, files };
}

describe('askPerson', () => {
  it('queues the question and returns the answer text', async () => {
    const { options, queued } = setup();
    let polls = 0;
    options.readAnswer = () => {
      polls += 1;
      return polls > 2
        ? JSON.stringify({ status: 'answered', text: 'Use B' })
        : null;
    };
    const result = await askPerson(QUESTIONS, options);
    expect(queued).toEqual([
      {
        v: 1,
        type: 'question',
        id: 'ask-1',
        questions: QUESTIONS,
        expiresAt: expect.any(String),
      },
    ]);
    expect(result).toBe('A person answered:\n\nUse B');
  });

  it('returns the no-answer text when the server expired it', async () => {
    const { options } = setup({
      'ask-1': JSON.stringify({ status: 'expired' }),
    });
    expect(await askPerson(QUESTIONS, options)).toMatch(
      /^No answer from a person/,
    );
  });

  it('gives the refusal as text when the host cancelled the question', async () => {
    const { options } = setup({
      'ask-1': JSON.stringify({ status: 'cancelled', reason: 'too many' }),
    });
    expect(await askPerson(QUESTIONS, options)).toBe(
      'Vantik refused the question: too many. Continue on your own judgement.',
    );
  });

  it('writes its own deadline into the question line', async () => {
    const { options, queued } = setup();
    await askPerson(QUESTIONS, options);
    expect(queued[0]).toMatchObject({ expiresAt: '1970-01-01T00:00:10.000Z' });
  });

  it('still takes an answer for a short time after its deadline', async () => {
    const { options } = setup();
    let polls = 0;
    options.readAnswer = () => {
      polls += 1;
      return options.now() > 10_000 && options.now() < 100_000
        ? JSON.stringify({ status: 'answered', text: 'late' })
        : null;
    };
    expect(await askPerson(QUESTIONS, options)).toContain('late');
    expect(polls).toBeGreaterThan(1);
  });

  it('returns the no-answer text at the limit', async () => {
    const { options } = setup();
    expect(await askPerson(QUESTIONS, options)).toMatch(/best judgement/);
  });

  it('reads a half-written file again at the next poll', async () => {
    const { options } = setup({ 'ask-1': '{"sta' });
    expect(await askPerson(QUESTIONS, options)).toMatch(/^No answer/);
  });

  it('stops when the signal aborts', async () => {
    const { options } = setup(
      {},
      {
        sleep: async () => {
          throw new Error('The question was aborted.');
        },
      },
    );
    await expect(askPerson(QUESTIONS, options)).rejects.toThrow(/aborted/);
  });
});

describe('parseAsked', () => {
  it('refuses two options with one label, as the host does', () => {
    expect(() =>
      parseAsked({
        questions: [
          { prompt: 'Which?', options: [{ label: 'A' }, { label: 'a' }] },
        ],
      }),
    ).toThrow(/different label/);
  });
});
