/**
 * Reads what happens in an omp session that a person drives in a terminal.
 *
 * omp writes every message of a session to `<agent dir>/sessions/<dir>/<time>_<uuid>.jsonl`.
 * A run of this connector streams its own events, so only the work that a
 * terminal does needs this reader. It remembers how far into each file it has
 * read, in a small file in the connector's config directory, and it moves that
 * position on only after the server acknowledged the entries before it.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** How often the connector looks at the session files. */
export const ACTIVITY_POLL_MS = 5_000;
/** The most entries and bytes of file in one `sessions.activity` message. */
export const MAX_BATCH_ENTRIES = 200;
export const MAX_BATCH_BYTES = 256 * 1024;
/** A string longer than this in an entry is cut, so one line cannot fill a message. */
const MAX_STRING = 16 * 1024;
/** How long to wait before looking again for a session file that was not found. */
const LOOKUP_RETRY_MS = 60_000;

/** The entry types the server turns into steps. */
const SENT_TYPES = new Set(['message', 'model_change']);
/**
 * The parts of a message that the server reads. The rest (the provider's
 * request body, the context snapshot, credentials) is large or private, and
 * stays on the machine.
 */
const MESSAGE_KEYS = [
  'role',
  'content',
  'model',
  'usage',
  'stopReason',
  'errorMessage',
  'timestamp',
  'toolCallId',
  'toolName',
  'isError',
  'details',
];

export interface ActivityBatch {
  externalId: string;
  entries: unknown[];
  /** Where the file is read up to once the server has acknowledged this batch. */
  nextOffset: number;
  /** More lines were waiting than one batch holds. */
  more: boolean;
}

export interface SessionTailOptions {
  /** The omp agent directory; its `sessions` directory holds the files. */
  agentDir(): string;
  /** Where the read positions are kept. */
  stateFile: string;
  now?(): number;
  log(message: string): void;
}

/** A file's name ends in the session's uuid. */
const fileFor = (id: string) => `_${id}.jsonl`;

export class SessionTail {
  private offsets = new Map<string, number>();
  private readonly paths = new Map<string, string>();
  private readonly lookedAt = new Map<string, number>();
  private loaded = false;

  constructor(private readonly options: SessionTailOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private load() {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const saved = JSON.parse(
        readFileSync(this.options.stateFile, 'utf8'),
      ) as Record<string, unknown>;
      for (const [id, offset] of Object.entries(saved)) {
        if (
          typeof offset === 'number' &&
          Number.isFinite(offset) &&
          offset >= 0
        ) {
          this.offsets.set(id, offset);
        }
      }
    } catch {
      // No file yet, or one that cannot be read: every session is new.
    }
  }

  private save() {
    try {
      mkdirSync(path.dirname(this.options.stateFile), { recursive: true });
      const temp = `${this.options.stateFile}.tmp`;
      writeFileSync(temp, JSON.stringify(Object.fromEntries(this.offsets)));
      renameSync(temp, this.options.stateFile);
    } catch (error) {
      this.options.log(
        `Could not save the session positions: ${String(error)}`,
      );
    }
  }

  /** The session's file, or null when omp has not written one on this machine. */
  find(id: string): string | null {
    const known = this.paths.get(id);
    if (known) {
      return known;
    }
    const looked = this.lookedAt.get(id);
    if (looked !== undefined && this.now() - looked < LOOKUP_RETRY_MS) {
      return null;
    }
    this.lookedAt.set(id, this.now());

    const root = path.join(this.options.agentDir(), 'sessions');
    try {
      for (const dir of readdirSync(root, { withFileTypes: true })) {
        if (!dir.isDirectory()) {
          continue;
        }
        const name = readdirSync(path.join(root, dir.name)).find((file) =>
          file.endsWith(fileFor(id)),
        );
        if (name) {
          const found = path.join(root, dir.name, name);
          this.paths.set(id, found);
          return found;
        }
      }
    } catch {
      // No sessions directory: omp has not run here.
    }
    return null;
  }

  /**
   * Moves the position of a session to the end of its file, so what is in the
   * file now is never sent. A run does this while it drives the session,
   * because the run reports that work itself.
   */
  skipToEnd(id: string): void {
    this.load();
    const file = this.find(id);
    if (!file) {
      return;
    }
    try {
      const size = statSync(file).size;
      if (this.offsets.get(id) !== size) {
        this.offsets.set(id, size);
        this.save();
      }
    } catch {
      // The file is gone; nothing to skip.
    }
  }

  /**
   * The next batch of entries for a session, or null when there is nothing new.
   * `fromEnd` says where a session starts that has no saved position: the end
   * of its file for a run's session, and the start for a terminal's.
   */
  next(id: string, fromEnd: boolean): ActivityBatch | null {
    this.load();
    const file = this.find(id);
    if (!file) {
      return null;
    }

    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      this.paths.delete(id);
      return null;
    }

    let offset = this.offsets.get(id);
    if (offset === undefined) {
      offset = fromEnd ? size : 0;
      this.offsets.set(id, offset);
      this.save();
    }
    // A file that became shorter was replaced; start from what it holds now.
    if (offset > size) {
      offset = size;
      this.offsets.set(id, offset);
      this.save();
    }
    if (offset === size) {
      return null;
    }

    const length = Math.min(size - offset, MAX_BATCH_BYTES * 2);
    const buffer = Buffer.alloc(length);
    let fd: number | undefined;
    try {
      fd = openSync(file, 'r');
      readSync(fd, buffer, 0, length, offset);
    } catch (error) {
      this.options.log(`Could not read ${file}: ${String(error)}`);
      return null;
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
      }
    }

    const entries: unknown[] = [];
    let used = 0;
    let more = length < size - offset;
    let start = 0;

    for (;;) {
      const end = buffer.indexOf(0x0a, start);
      // The last line may be half written; it waits for its newline.
      if (end === -1) {
        break;
      }
      if (
        entries.length >= MAX_BATCH_ENTRIES ||
        (used > 0 && end + 1 > MAX_BATCH_BYTES)
      ) {
        more = true;
        break;
      }
      const entry = slimEntry(buffer.subarray(start, end).toString('utf8'));
      if (entry) {
        entries.push(entry);
      }
      start = end + 1;
      used = start;
    }

    // A single line longer than the buffer: skip past it, or the reader would
    // wait for ever. omp lines this long are tool output nobody needs.
    if (used === 0 && length >= MAX_BATCH_BYTES * 2 && length < size - offset) {
      const skipped = this.skipLine(file, offset + length);
      if (skipped !== null) {
        return { externalId: id, entries: [], nextOffset: skipped, more: true };
      }
    }

    if (used === 0) {
      return null;
    }

    return { externalId: id, entries, nextOffset: offset + used, more };
  }

  /** The offset after the next newline at or past `from`, or null when none is there yet. */
  private skipLine(file: string, from: number): number | null {
    let fd: number | undefined;
    try {
      fd = openSync(file, 'r');
      const chunk = Buffer.alloc(64 * 1024);
      let at = from;
      for (;;) {
        const read = readSync(fd, chunk, 0, chunk.length, at);
        if (read === 0) {
          return null;
        }
        const newline = chunk.subarray(0, read).indexOf(0x0a);
        if (newline !== -1) {
          return at + newline + 1;
        }
        at += read;
      }
    } catch {
      return null;
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
      }
    }
  }

  /** Records that the server took a batch. */
  commit(batch: ActivityBatch): void {
    this.offsets.set(batch.externalId, batch.nextOffset);
    this.save();
  }
}

/**
 * One file line as the entry the server reads, or null for a line that is not
 * worth sending: a title, a custom entry, a line that does not parse.
 */
export function slimEntry(line: string): Record<string, unknown> | null {
  let entry: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    entry = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  if (typeof entry.type !== 'string' || !SENT_TYPES.has(entry.type)) {
    return null;
  }

  if (entry.type === 'model_change') {
    return {
      type: 'model_change',
      timestamp: entry.timestamp,
      model: entry.model,
    };
  }

  const message = entry.message as Record<string, unknown> | undefined;
  if (typeof message !== 'object' || message === null) {
    return null;
  }

  const kept: Record<string, unknown> = {};
  for (const key of MESSAGE_KEYS) {
    if (key in message) {
      kept[key] = cut(message[key]);
    }
  }
  return {
    type: 'message',
    id: entry.id,
    timestamp: entry.timestamp,
    message: kept,
  };
}

/** Shortens every long string in a value. */
function cut(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.map(cut);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, cut(inner)]),
    );
  }
  return value;
}
