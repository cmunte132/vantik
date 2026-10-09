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

import { MAX_BATCH_ENTRIES, SessionTail, slimEntry } from './session-tail';

const ID = '01a1212b-ef89-7545-abb3-1339176a6b81';

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const user = (text: string) =>
  line({
    type: 'message',
    id: text,
    timestamp: '2026-10-09T10:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] },
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

  it('starts a terminal session at its first line and a run session at its end', () => {
    expect(build().next(ID, true)).toBeNull();
    appendFileSync(file, user('second'));
    expect(build().next(ID, true)?.entries).toHaveLength(1);

    rmSync(path.join(dir, 'state'), { recursive: true, force: true });
    expect(build().next(ID, false)?.entries).toHaveLength(2);
  });

  it('moves on only when a batch is committed, and keeps its place across restarts', () => {
    const first = tail.next(ID, false);
    expect(tail.next(ID, false)?.nextOffset).toBe(first?.nextOffset);

    if (first) {
      tail.commit(first);
    }
    expect(tail.next(ID, false)).toBeNull();

    appendFileSync(file, user('second'));
    const restarted = build().next(ID, false);
    expect(restarted?.entries).toHaveLength(1);
    expect(JSON.stringify(restarted?.entries)).toContain('second');
    expect(
      readFileSync(path.join(dir, 'state', 'offsets.json'), 'utf8'),
    ).toContain(ID);
  });

  it('waits for the end of a line that is half written', () => {
    const first = tail.next(ID, false);
    if (first) {
      tail.commit(first);
    }
    appendFileSync(file, '{"type":"message","message":{"role":"us');
    expect(tail.next(ID, false)).toBeNull();

    appendFileSync(file, 'er","content":"hi"}}\n');
    expect(tail.next(ID, false)?.entries).toHaveLength(1);
  });

  it('cuts a long file into batches', () => {
    for (let i = 0; i < MAX_BATCH_ENTRIES + 5; i += 1) {
      appendFileSync(file, user(`m${i}`));
    }
    const first = tail.next(ID, false);
    expect(first?.entries).toHaveLength(MAX_BATCH_ENTRIES);
    expect(first?.more).toBe(true);
    if (first) {
      tail.commit(first);
    }
    expect(tail.next(ID, false)?.entries).toHaveLength(6);
  });

  it("skips a session to its end, so a run's own work is not sent again", () => {
    tail.skipToEnd(ID);
    expect(tail.next(ID, false)).toBeNull();
  });

  it('finds nothing for a session omp never wrote', () => {
    expect(tail.next('02b2212b-ef89-7545-abb3-1339176a6b81', false)).toBeNull();
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
});
