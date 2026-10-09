import {
  AckedQueue,
  type ConnectorAckLike,
  type QueueTransport,
} from './queue';

interface Emitted {
  event: string;
  payload: Record<string, unknown>;
}

function transport() {
  const emitted: Emitted[] = [];
  const state = {
    connected: true,
    /** What the fake server answers; undefined is silence. */
    answer: (_message: Emitted): ConnectorAckLike | undefined => ({ ok: true }),
  };
  const fake: QueueTransport = {
    get connected() {
      return state.connected;
    },
    emit(event, payload, ack) {
      const message = { event, payload: payload as Record<string, unknown> };
      emitted.push(message);
      const answer = state.answer(message);
      if (answer) {
        setImmediate(() => ack(answer));
      }
    },
  };
  return { fake, state, emitted };
}

describe('the acknowledged run queue', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('numbers messages per run and sends them in seq order, one at a time', async () => {
    const { fake, emitted } = transport();
    const queue = new AckedQueue('run-1', fake);

    queue.send('run.started', { branch: 'b' });
    queue.send('run.events', { events: [1] });
    queue.send('run.finished', { outcome: 'succeeded' });

    await expect(queue.drain(1000)).resolves.toBe(true);
    expect(
      emitted.map((m) => [m.event, m.payload.seq, m.payload.runId]),
    ).toEqual([
      ['run.started', 1, 'run-1'],
      ['run.events', 2, 'run-1'],
      ['run.finished', 3, 'run-1'],
    ]);
  });

  it('holds a message the server does not acknowledge, and repeats it with the same seq', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const { fake, state, emitted } = transport();
    let silent = true;
    state.answer = () => (silent ? undefined : { ok: true });
    const queue = new AckedQueue('run-1', fake, { ackTimeoutMs: 100 });

    queue.send('run.events', { events: [1] });
    queue.send('run.events', { events: [2] });
    await jest.advanceTimersByTimeAsync(100);
    expect(emitted).toHaveLength(1);
    expect(queue.pending).toBe(2);

    silent = false;
    await jest.advanceTimersByTimeAsync(100);
    await jest.advanceTimersByTimeAsync(0);

    expect(emitted.map((m) => m.payload.seq)).toEqual([1, 1, 2]);
    expect(queue.pending).toBe(0);
  });

  it('waits while disconnected and sends everything, in order, on resume', async () => {
    const { fake, state, emitted } = transport();
    state.connected = false;
    const queue = new AckedQueue('run-1', fake);

    queue.send('run.started', {});
    queue.send('run.events', {});
    expect(emitted).toHaveLength(0);
    expect(queue.pending).toBe(2);

    state.connected = true;
    queue.resume();

    await expect(queue.drain(1000)).resolves.toBe(true);
    expect(emitted.map((m) => m.payload.seq)).toEqual([1, 2]);
  });

  it('retries a refused message, then drops it so later messages are not stuck', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const { fake, state, emitted } = transport();
    const dropped: string[] = [];
    state.answer = (message) =>
      message.payload.seq === 1 ? { ok: false, reason: 'bad' } : { ok: true };
    const queue = new AckedQueue('run-1', fake, {
      maxRefusals: 2,
      refusalDelayMs: 10,
      onDrop: (message, reason) => dropped.push(`${message.seq}:${reason}`),
    });

    queue.send('run.events', {});
    queue.send('run.finished', {});
    await jest.advanceTimersByTimeAsync(50);
    await jest.advanceTimersByTimeAsync(0);

    expect(dropped).toEqual(['1:bad']);
    expect(emitted.map((m) => m.payload.seq)).toEqual([1, 1, 2]);
    expect(queue.pending).toBe(0);
  });

  it('gives up draining after the timeout', async () => {
    const { fake, state } = transport();
    state.connected = false;
    const queue = new AckedQueue('run-1', fake);
    queue.send('run.finished', {});

    await expect(queue.drain(20)).resolves.toBe(false);
  });

  it('does not retry a refused head message when new messages are queued during the backoff', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const { fake, state, emitted } = transport();
    state.answer = (message) =>
      message.payload.seq === 1 ? { ok: false, reason: 'bad' } : { ok: true };
    const queue = new AckedQueue('run-1', fake, {
      maxRefusals: 3,
      refusalDelayMs: 1000,
    });

    queue.send('run.events', {});
    await jest.advanceTimersByTimeAsync(10);
    expect(emitted).toHaveLength(1);

    // More traffic during the backoff must not resend the refused message.
    for (let i = 0; i < 3; i++) {
      queue.send('run.events', {});
      await jest.advanceTimersByTimeAsync(250);
    }
    expect(emitted).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(300);
    expect(emitted.filter((m) => m.payload.seq === 1)).toHaveLength(2);
  });

  it('tells the owner about each refusal and stops when it closes the queue', async () => {
    const { fake, state, emitted } = transport();
    state.answer = () => ({ ok: false, reason: 'untracked: no such run' });
    const reasons: string[] = [];
    const queue: AckedQueue = new AckedQueue('run-1', fake, {
      onRefusal: (_m, reason) => {
        reasons.push(reason);
        queue.close();
      },
    });

    queue.send('run.events', {});
    queue.send('run.finished', {});
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(reasons).toEqual(['untracked: no such run']);
    expect(emitted).toHaveLength(1);
  });
});
