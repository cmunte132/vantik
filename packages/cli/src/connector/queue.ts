/**
 * Acknowledged delivery of one run's messages to the server.
 *
 * Every connector-to-server message carries the run id and a per-run sequence
 * number that only rises. The queue sends one message at a time, in seq order,
 * and removes it only when the server acknowledges it. A message that is not
 * acknowledged stays, and goes again after the socket reconnects. The server
 * treats each (runId, seq) as idempotent, so a repeat is safe.
 */

export type ConnectorAckLike = { ok: true } | { ok: false; reason: string };

/** What the queue needs from the socket. */
export interface QueueTransport {
  readonly connected: boolean;
  emit(
    event: string,
    payload: unknown,
    ack: (response: ConnectorAckLike | undefined) => void,
  ): void;
}

interface Message {
  seq: number;
  event: string;
  payload: Record<string, unknown>;
  /** Rejections by the server, as opposed to a missing answer. */
  refusals: number;
}

export interface AckedQueueOptions {
  /** How long to wait for an acknowledgement before sending again. */
  ackTimeoutMs?: number;
  /** After this many refusals the server will never accept the message. */
  maxRefusals?: number;
  /** Pause after a refusal, doubled each time. */
  refusalDelayMs?: number;
  /** Every refusal, before any retry. */
  onRefusal?(message: { event: string; seq: number }, reason: string): void;
  onDrop?(message: { event: string; seq: number }, reason: string): void;
}

export class AckedQueue {
  private seq = 0;
  private readonly messages: Message[] = [];
  private sending = false;
  private idleWaiters: Array<() => void> = [];
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  /** A refusal's backoff is running; nothing is sent until it ends. */
  private backingOff = false;

  constructor(
    private readonly runId: string,
    private readonly transport: QueueTransport,
    private readonly options: AckedQueueOptions = {},
  ) {}

  /** Queues a message and returns the seq it carries. */
  send(event: string, fields: Record<string, unknown>): number {
    const seq = ++this.seq;
    this.messages.push({
      seq,
      event,
      payload: { ...fields, runId: this.runId, seq },
      refusals: 0,
    });
    void this.pump();
    return seq;
  }

  get pending() {
    return this.messages.length;
  }

  /** Call when the socket has reconnected, to send what is waiting. */
  resume() {
    // A refusal's backoff is not cut short by a reconnect; a lost answer is.
    if (!this.backingOff) {
      clearTimeout(this.retryTimer);
      void this.pump();
    }
  }

  /** Resolves when nothing is waiting, or after `timeoutMs`. */
  async drain(timeoutMs: number): Promise<boolean> {
    if (this.messages.length === 0) {
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((w) => w !== done);
        resolve(false);
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.idleWaiters.push(done);
    });
  }

  close() {
    this.closed = true;
    this.backingOff = false;
    clearTimeout(this.retryTimer);
  }

  private settleIdle() {
    if (this.messages.length === 0) {
      for (const waiter of this.idleWaiters.splice(0)) {
        waiter();
      }
    }
  }

  private async pump(): Promise<void> {
    if (this.sending || this.closed || this.backingOff) {
      return;
    }
    this.sending = true;
    try {
      while (
        this.messages.length > 0 &&
        this.transport.connected &&
        !this.closed
      ) {
        const message = this.messages[0] as Message;
        const answer = await this.attempt(message);

        if (answer === undefined) {
          // No answer: the socket is gone or slow. Try again when it is back,
          // or soon if it still claims to be connected.
          this.scheduleRetry(this.options.ackTimeoutMs ?? 10_000);
          return;
        }
        if (answer.ok) {
          this.messages.shift();
          continue;
        }

        message.refusals += 1;
        this.options.onRefusal?.(message, answer.reason);
        if (this.closed) {
          return;
        }
        if (message.refusals >= (this.options.maxRefusals ?? 5)) {
          this.messages.shift();
          this.options.onDrop?.(message, answer.reason);
          continue;
        }
        this.scheduleRetry(
          (this.options.refusalDelayMs ?? 1000) * 2 ** (message.refusals - 1),
          true,
        );
        return;
      }
    } finally {
      this.sending = false;
      this.settleIdle();
    }
  }

  private attempt(message: Message): Promise<ConnectorAckLike | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: ConnectorAckLike | undefined) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      };
      const timer = setTimeout(
        () => finish(undefined),
        this.options.ackTimeoutMs ?? 10_000,
      );
      try {
        this.transport.emit(message.event, message.payload, finish);
      } catch {
        finish(undefined);
      }
    });
  }

  private scheduleRetry(delayMs: number, backoff = false) {
    clearTimeout(this.retryTimer);
    this.backingOff = backoff;
    this.retryTimer = setTimeout(() => {
      this.backingOff = false;
      void this.pump();
    }, delayMs);
  }
}
