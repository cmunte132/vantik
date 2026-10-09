import { EventEmitter } from 'node:events';

import {
  LineSplitter,
  OmpDriver,
  parseRpcLine,
  type OmpChildLike,
} from './rpc';

class FakeOmp extends EventEmitter {
  written: Array<Record<string, unknown>> = [];
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: string[] = [];
  stdin = {
    write: (chunk: string) => {
      const command = JSON.parse(chunk) as Record<string, unknown>;
      this.written.push(command);
      this.onCommand?.(command);
      return true;
    },
  };
  onCommand: ((command: Record<string, unknown>) => void) | undefined;

  kill(signal?: string) {
    this.killed.push(signal ?? 'SIGTERM');
    this.emit('exit', null, signal ?? 'SIGTERM');
  }

  emitLine(value: unknown) {
    this.stdout.emit('data', `${JSON.stringify(value)}\n`);
  }

  respond(command: Record<string, unknown>, data?: unknown, success = true) {
    this.emitLine({
      id: command.id,
      type: 'response',
      command: command.type,
      success,
      ...(success ? { data } : { error: 'nope' }),
    });
  }
}

const asChild = (fake: FakeOmp) => fake as unknown as OmpChildLike;

describe('the omp line framing', () => {
  it('splits lines that arrive in pieces and keeps the partial tail', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(splitter.push(':2}\r\n\n{"c":3}')).toEqual(['{"b":2}']);
    expect(splitter.flush()).toEqual(['{"c":3}']);
    expect(splitter.flush()).toEqual([]);
  });

  it('reads JSON objects with a type and ignores other output', () => {
    expect(parseRpcLine('{"type":"agent_end"}')).toEqual({ type: 'agent_end' });
    expect(parseRpcLine('plain text')).toBeNull();
    expect(parseRpcLine('[1]')).toBeNull();
    expect(parseRpcLine('{"no":"type"}')).toBeNull();
  });
});

describe('the omp driver', () => {
  it('matches responses to requests by id', async () => {
    const fake = new FakeOmp();
    fake.onCommand = (command) => {
      if (command.type === 'get_state') {
        fake.respond(command, {
          sessionId: 's1',
          sessionFile: '/tmp/s1.jsonl',
        });
      }
    };
    const driver = new OmpDriver(asChild(fake));

    await expect(driver.getState()).resolves.toEqual({
      sessionId: 's1',
      sessionFile: '/tmp/s1.jsonl',
    });
    expect(fake.written[0]).toMatchObject({ type: 'get_state', id: '1' });
  });

  it('rejects a command omp refuses', async () => {
    const fake = new FakeOmp();
    fake.onCommand = (command) => fake.respond(command, undefined, false);
    const driver = new OmpDriver(asChild(fake));

    await expect(driver.abort()).rejects.toThrow('omp refused abort: nope');
  });

  it('forwards events in order, without the noise', () => {
    const fake = new FakeOmp();
    const driver = new OmpDriver(asChild(fake));
    const seen: string[] = [];
    driver.onEvent((event) => seen.push(event.type));

    fake.emitLine({ type: 'ready' });
    fake.emitLine({ type: 'agent_start' });
    fake.emitLine({ type: 'extension_ui_request', id: 'x' });
    fake.emitLine({
      type: 'message_end',
      message: { role: 'user', content: 'hi' },
    });

    expect(seen).toEqual(['agent_start', 'message_end']);
  });

  it('keeps the last assistant message as the summary', async () => {
    const fake = new FakeOmp();
    const driver = new OmpDriver(asChild(fake));
    const ended = driver.waitForAgentEnd();

    fake.emitLine({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'First.' }],
      },
    });
    fake.emitLine({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'hmm' },
          { type: 'text', text: 'Done: ' },
          { type: 'text', text: 'all tests pass.' },
        ],
        stopReason: 'stop',
      },
    });
    fake.emitLine({ type: 'agent_end', messages: [] });
    await ended;

    expect(driver.lastAssistantMessage).toEqual({
      text: 'Done: all tests pass.',
      stopReason: 'stop',
      errorMessage: null,
    });
  });

  it('polls custom entries from a cursor and queues overlapping polls', async () => {
    const fake = new FakeOmp();
    const sinceSeen: unknown[] = [];
    const batches = [
      [
        { type: 'model_change', id: 'a' },
        { type: 'custom', id: 'b', customType: 'x', data: 1 },
      ],
      [{ type: 'message', id: 'c' }],
      [{ type: 'custom', id: 'd', customType: 'y', data: 2 }],
    ];
    fake.onCommand = (command) => {
      sinceSeen.push(command.since);
      fake.respond(command, { entries: batches.shift() ?? [] });
    };
    const driver = new OmpDriver(asChild(fake));

    const [first, second, third] = await Promise.all([
      driver.pollEntries(),
      driver.pollEntries(),
      driver.pollEntries(),
    ]);

    expect(first).toEqual([
      { type: 'custom', id: 'b', customType: 'x', data: 1 },
    ]);
    expect(second).toEqual([]);
    expect(third).toEqual([
      { type: 'custom', id: 'd', customType: 'y', data: 2 },
    ]);
    expect(sinceSeen).toEqual([undefined, 'b', 'c']);
  });

  it('fails waiting requests and the agent wait when omp exits, with the stderr tail', async () => {
    const fake = new FakeOmp();
    const driver = new OmpDriver(asChild(fake));
    const pending = driver.getState();
    const ended = driver.waitForAgentEnd();
    const failures = Promise.allSettled([pending, ended]);

    fake.stderr.emit('data', 'no api key for provider\n');
    fake.emit('exit', 1, null);

    const [a, b] = await failures;
    expect(a).toMatchObject({ status: 'rejected' });
    expect(String((b as PromiseRejectedResult).reason)).toContain(
      'no api key for provider',
    );
    await expect(driver.exited).resolves.toMatchObject({
      code: 1,
      stderrTail: 'no api key for provider',
    });
  });

  it('is idle only after the last turn, when a handler starts another from agent_end', async () => {
    jest.useFakeTimers();
    try {
      const fake = new FakeOmp();
      let settled = false;
      fake.onCommand = (command) =>
        fake.respond(command, { isSettled: settled });
      const driver = new OmpDriver(asChild(fake));
      let done = 0;
      const idle = driver
        .waitForIdle({ settleMs: 1500, pollMs: 300 })
        .then(() => {
          done += 1;
        });

      fake.emitLine({ type: 'agent_start' });
      fake.emitLine({ type: 'agent_end', messages: [] });
      await jest.advanceTimersByTimeAsync(500);
      // The extension's reminder starts a second turn inside the window.
      fake.emitLine({ type: 'agent_start' });
      await jest.advanceTimersByTimeAsync(5000);
      expect(done).toBe(0);
      expect(fake.written).toHaveLength(0);

      fake.emitLine({ type: 'agent_end', messages: [] });
      await jest.advanceTimersByTimeAsync(1500);
      // Quiet for the window, but omp still reports unsettled work.
      expect(done).toBe(0);
      settled = true;
      await jest.advanceTimersByTimeAsync(300);
      await idle;
      expect(done).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('opts in to ask dialogs', async () => {
    const fake = new FakeOmp();
    fake.onCommand = (command) => fake.respond(command, { enabled: true });
    await new OmpDriver(asChild(fake)).setAskDialog(true);
    expect(fake.written[0]).toMatchObject({
      type: 'set_ask_dialog',
      enabled: true,
    });
  });
});
