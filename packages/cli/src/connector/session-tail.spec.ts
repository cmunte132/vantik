import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  MAX_BATCH_ENTRIES,
  SessionTail,
  type SessionSource,
  slimEntry,
} from './session-tail';

const ID = '01a1212b-ef89-7545-abb3-1339176a6b81';
const CHILD = '03c3212b-ef89-7545-abb3-1339176a6b81';

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const user = (text: string) =>
  line({
    type: 'message',
    id: text,
    timestamp: '2026-10-09T10:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
const assistant = (id: string, text: string) =>
  line({
    type: 'message',
    id,
    timestamp: '2026-10-09T10:05:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });

describe('SessionTail', () => {
  let dir: string;
  let file: string;
  let tail: SessionTail;

  const build = () =>
    new SessionTail({
      agentDir: () => dir,
      stateFile: path.join(dir, 'state', 'offsets.json'),
      log: () => undefined,
    });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'session-tail-'));
    const sessions = path.join(dir, 'sessions', '-work');
    mkdirSync(sessions, { recursive: true });
    file = path.join(sessions, `2026-10-09T10-00-00-000Z_${ID}.jsonl`);
    writeFileSync(
      file,
      line({ type: 'title', title: 'x' }) +
        line({ type: 'session', id: ID }) +
        user('first'),
    );
    tail = build();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('starts a session with no saved position at its first line', () => {
    expect(build().next(ID)?.entries).toHaveLength(1);
  });

  it('moves on only when a batch is committed, and keeps its place across restarts', () => {
    const first = tail.next(ID);
    expect(tail.next(ID)?.nextOffset).toBe(first?.nextOffset);

    if (first) {
      tail.commit(first);
    }
    expect(tail.next(ID)).toBeNull();

    appendFileSync(file, user('second'));
    const restarted = build().next(ID);
    expect(restarted?.entries).toHaveLength(1);
    expect(JSON.stringify(restarted?.entries)).toContain('second');
    expect(
      readFileSync(path.join(dir, 'state', 'offsets.json'), 'utf8'),
    ).toContain(ID);
  });

  it('waits for the end of a line that is half written', () => {
    const first = tail.next(ID);
    if (first) {
      tail.commit(first);
    }
    appendFileSync(file, '{"type":"message","message":{"role":"us');
    expect(tail.next(ID)).toBeNull();

    appendFileSync(file, 'er","content":"hi"}}\n');
    expect(tail.next(ID)?.entries).toHaveLength(1);
  });

  it('cuts a long file into batches', () => {
    for (let i = 0; i < MAX_BATCH_ENTRIES + 5; i += 1) {
      appendFileSync(file, user(`m${i}`));
    }
    const first = tail.next(ID);
    expect(first?.entries).toHaveLength(MAX_BATCH_ENTRIES);
    expect(first?.more).toBe(true);
    if (first) {
      tail.commit(first);
    }
    expect(tail.next(ID)?.entries).toHaveLength(6);
  });

  it("skips a session to its end, so a run's own work is not sent again", () => {
    tail.skipToEnd(ID);
    expect(tail.next(ID)).toBeNull();
  });

  it('finds nothing for a session omp never wrote', () => {
    expect(tail.next('02b2212b-ef89-7545-abb3-1339176a6b81')).toBeNull();
  });

  it('sends the same entries with the same ids again until a batch is committed', () => {
    const first = tail.next(ID);
    expect(build().next(ID)?.entries).toEqual(first?.entries);
    expect(first?.entries).toEqual([
      expect.objectContaining({ type: 'message', id: 'first' }),
    ]);
  });
});

describe('child sessions', () => {
  const stem = `2026-10-09T10-00-00-000Z_${ID}`;
  let dir: string;
  let folder: string;
  let tail: SessionTail;

  const build = () =>
    new SessionTail({
      agentDir: () => dir,
      stateFile: path.join(dir, 'state', 'offsets.json'),
      log: () => undefined,
    });

  /** The n-th child that the root has, as the tail lists them. */
  const source = (t: SessionTail, n: number): SessionSource => {
    const found = t.children(ID)[n];
    if (!found) {
      throw new Error(`no child ${n}`);
    }
    return found;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'session-tail-children-'));
    const sessions = path.join(dir, 'sessions', '-work');
    folder = path.join(sessions, stem);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      path.join(sessions, `${stem}.jsonl`),
      line({ type: 'session', id: ID }) + user('first'),
    );
    tail = build();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a child under the root with its own native id and start, and the root without them', () => {
    writeFileSync(
      path.join(folder, `child-${CHILD}.jsonl`),
      line({
        type: 'session',
        id: CHILD,
        timestamp: '2026-10-09T10:05:00.000Z',
      }) + assistant('c1', 'child work'),
    );

    expect(tail.children(ID)).toEqual([
      expect.objectContaining({
        sourceSessionId: CHILD,
        sourceStartedAt: '2026-10-09T10:05:00.000Z',
      }),
    ]);

    const batch = tail.nextFrom(ID, source(tail, 0));
    expect(batch).toMatchObject({
      externalId: ID,
      sourceSessionId: CHILD,
      sourceStartedAt: '2026-10-09T10:05:00.000Z',
      entries: [{ type: 'message', id: 'c1' }],
    });
    // The header is not sent, only the work.
    expect(batch?.entries).toHaveLength(1);

    expect(tail.next(ID)).not.toHaveProperty('sourceSessionId');
  });

  it("keeps each child's position apart, across restarts, and finds a child that appears later", () => {
    writeFileSync(
      path.join(folder, 'a.jsonl'),
      line({ type: 'session', id: 'a-id' }) + assistant('a1', 'a'),
    );
    const firstBatch = tail.nextFrom(ID, source(tail, 0));
    if (firstBatch) {
      tail.commit(firstBatch);
    }
    expect(tail.nextFrom(ID, source(tail, 0))).toBeNull();

    writeFileSync(
      path.join(folder, 'b.jsonl'),
      line({ type: 'session', id: 'b-id' }) + assistant('b1', 'b'),
    );
    expect(tail.children(ID).map((child) => child.sourceSessionId)).toEqual([
      'a-id',
      'b-id',
    ]);
    expect(tail.nextFrom(ID, source(tail, 1))?.entries).toHaveLength(1);

    const restarted = build();
    expect(restarted.nextFrom(ID, source(restarted, 0))).toBeNull();
    expect(restarted.nextFrom(ID, source(restarted, 1))?.entries).toHaveLength(
      1,
    );
  });

  it('reads the id and start of a child whose first line is a padded title', () => {
    writeFileSync(
      path.join(folder, `child-${CHILD}.jsonl`),
      `${JSON.stringify({ type: 'title', title: 'job' })}${' '.repeat(300)}\n${line(
        {
          type: 'session',
          id: CHILD,
          timestamp: '2026-10-09T10:05:00.000Z',
          cwd: '/work',
          parentSession: `${stem}.jsonl`,
        },
      )}${assistant('c1', 'child work')}`,
    );

    expect(tail.children(ID)).toEqual([
      expect.objectContaining({
        sourceSessionId: CHILD,
        sourceStartedAt: '2026-10-09T10:05:00.000Z',
      }),
    ]);
    expect(tail.nextFrom(ID, source(tail, 0))).toMatchObject({
      sourceSessionId: CHILD,
      entries: [{ type: 'message', id: 'c1' }],
    });
  });

  it('waits for a child header that is still being written, then uses its native id', () => {
    const file = path.join(folder, `child-${CHILD}.jsonl`);
    const header = line({
      type: 'session',
      id: CHILD,
      timestamp: '2026-10-09T10:05:00.000Z',
    });
    // The title is whole, the header is half written: no identity yet.
    writeFileSync(
      file,
      line({ type: 'title', title: 'job' }) + header.slice(0, 20),
    );
    expect(tail.children(ID)).toEqual([]);

    writeFileSync(
      file,
      line({ type: 'title', title: 'job' }) + header + assistant('c1', 'work'),
    );
    expect(tail.children(ID)).toEqual([
      expect.objectContaining({ sourceSessionId: CHILD }),
    ]);
    expect(tail.nextFrom(ID, source(tail, 0))).toMatchObject({
      sourceSessionId: CHILD,
      entries: [{ type: 'message', id: 'c1' }],
    });
  });

  it('names a child with no header, once its window has been read, by its root-relative file', () => {
    // A title longer than the header window, and no header in that window.
    writeFileSync(
      path.join(folder, 'loose.jsonl'),
      line({ type: 'title', title: 'x'.repeat(70_000) }) +
        assistant('l1', 'loose'),
    );

    const child = source(tail, 0);
    expect(child.sourceSessionId).toBe(`file:${stem}/loose.jsonl`);
    expect(child.sourceStartedAt).toBeUndefined();
    expect(tail.nextFrom(ID, child)).toMatchObject({
      externalId: ID,
      sourceSessionId: `file:${stem}/loose.jsonl`,
    });
  });

  it('still reads a child after its root was skipped to its end', () => {
    tail.skipToEnd(ID);
    expect(tail.next(ID)).toBeNull();

    writeFileSync(
      path.join(folder, `child-${CHILD}.jsonl`),
      line({ type: 'session', id: CHILD }) + assistant('c1', 'child work'),
    );
    expect(tail.nextFrom(ID, source(tail, 0))?.entries).toHaveLength(1);
  });
});

describe('slimEntry', () => {
  it('drops the provider payload and keeps what makes a step', () => {
    const slim = slimEntry(
      JSON.stringify({
        type: 'message',
        id: 'a',
        timestamp: 't',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          usage: { cost: { total: 1 } },
          providerPayload: { big: 'x' },
          contextSnapshot: 'y',
        },
      }),
    );

    expect(slim?.message).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      usage: { cost: { total: 1 } },
    });
  });

  it('skips titles, custom entries and lines that do not parse', () => {
    expect(slimEntry('{"type":"title"}')).toBeNull();
    expect(slimEntry('{"type":"custom","data":{}}')).toBeNull();
    expect(slimEntry('not json')).toBeNull();
  });

  it('cuts a very long string', () => {
    const slim = slimEntry(
      JSON.stringify({
        type: 'message',
        message: {
          role: 'toolResult',
          content: [{ text: 'x'.repeat(50_000) }],
        },
      }),
    );
    const text = (slim?.message as { content: Array<{ text: string }> })
      .content[0]?.text as string;
    expect(text.length).toBeLessThan(20_000);
  });

  it('keeps the provider fields of a message, and drops its request body and credential', () => {
    const slim = slimEntry(
      JSON.stringify({
        type: 'message',
        id: 'a1',
        timestamp: '2026-10-09T10:05:00.000Z',
        message: {
          role: 'assistant',
          provider: 'openai-codex',
          api: 'openai-responses',
          model: 'gpt-5',
          responseId: 'resp_1',
          serviceTier: 'priority',
          usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 0 },
          providerPayload: { big: 'x' },
          credentialId: 'cred-1',
        },
      }),
    );

    expect(slim).toEqual({
      type: 'message',
      id: 'a1',
      timestamp: '2026-10-09T10:05:00.000Z',
      message: {
        role: 'assistant',
        provider: 'openai-codex',
        api: 'openai-responses',
        model: 'gpt-5',
        responseId: 'resp_1',
        serviceTier: 'priority',
        usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 0 },
      },
    });
  });

  it('keeps an auxiliary model request with its purpose, and drops its request body and credential', () => {
    const slim = slimEntry(
      JSON.stringify({
        type: 'model_usage',
        id: 'u1',
        timestamp: '2026-10-09T10:06:00.000Z',
        provider: 'openrouter',
        api: 'openai-completions',
        model: 'deepseek',
        usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 },
        responseId: 'resp_9',
        purpose: 'title',
        credentialId: 'cred-2',
        providerPayload: { big: 'x' },
      }),
    );

    expect(slim).toEqual({
      type: 'model_usage',
      id: 'u1',
      timestamp: '2026-10-09T10:06:00.000Z',
      provider: 'openrouter',
      api: 'openai-completions',
      model: 'deepseek',
      usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 },
      responseId: 'resp_9',
      purpose: 'title',
    });
  });

  it('keeps the id of a model change', () => {
    expect(
      slimEntry(
        JSON.stringify({
          type: 'model_change',
          id: 'm1',
          timestamp: '2026-10-09T10:07:00.000Z',
          model: 'openai-codex/gpt-5',
        }),
      ),
    ).toEqual({
      type: 'model_change',
      id: 'm1',
      timestamp: '2026-10-09T10:07:00.000Z',
      model: 'openai-codex/gpt-5',
    });
  });
});
