/**
 * Reads what happens in an omp session that a person drives in a terminal.
 *
 * omp writes every message of a session to `<agent dir>/sessions/<dir>/<time>_<uuid>.jsonl`.
 * A session that the root spawns (a child) is written beneath a folder named
 * after the root file, `<agent dir>/sessions/<dir>/<time>_<uuid>/**.jsonl`.
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
  type Dirent,
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
/** How deep beneath a root's folder a child session file is looked for. */
const MAX_CHILD_DEPTH = 3;
/**
 * The part of a file that is read to find its session header. omp writes a
 * title line before the header, so the header is searched among the lines here.
 */
const HEADER_BYTES = 64 * 1024;

/** The entry types the server turns into steps or usage. */
const SENT_TYPES: Record<string, true> = {
  message: true,
  model_change: true,
  model_usage: true,
};
/**
 * The parts of a message that the server reads. The rest (the provider's
 * request body, the context snapshot, credentials) is large or private, and
 * stays on the machine.
 */
const MESSAGE_KEYS = [
  'role',
  'content',
  'model',
  'provider',
  'api',
  'responseId',
  'serviceTier',
  'usage',
  'stopReason',
  'errorMessage',
  'timestamp',
  'toolCallId',
  'toolName',
  'isError',
  'details',
];
/** The parts of an auxiliary model request (`model_usage`) that the server reads. */
const MODEL_USAGE_KEYS = [
  'id',
  'timestamp',
  'provider',
  'api',
  'model',
  'usage',
  'responseId',
  'purpose',
];

/** One batch of one session file, ready to send. */
export interface ActivityBatch {
  /** The watched root session. */
  externalId: string;
  /** The child's native id, or a root-relative identity. Omitted for the root. */
  sourceSessionId?: string;
  /** When the child started. Omitted for the root. */
  sourceStartedAt?: string;
  entries: unknown[];
  /** Where the file is read up to once the server has acknowledged this batch. */
  nextOffset: number;
  /** More lines were waiting than one batch holds. */
  more: boolean;
  /** The read position this batch moves, which {@link SessionTail.commit} records. */
  key: string;
}

/** A session file to read: the root's, or one of its children. */
export interface SessionSource {
  file: string;
  /** Where the read position is kept. Unique per file. */
  key: string;
  /** The child's native id, or a root-relative identity. Omitted for the root. */
  sourceSessionId?: string;
  /** When the child started, from its header. */
  sourceStartedAt?: string;
}

export interface SessionTailOptions {
  /** The omp agent directory; its `sessions` directory holds the files. */
  agentDir(): string;
  /** Where the read positions are kept. */
  stateFile: string;
  now?(): number;
  log(message: string): void;
}

/** The id and start a session file declares in its first line. */
interface SessionHeader {
  id?: string;
  timestamp?: string;
}

/** A file's name ends in the session's uuid. */
const fileFor = (id: string) => `_${id}.jsonl`;

export class SessionTail {
  private offsets = new Map<string, number>();
  private readonly paths = new Map<string, string>();
  private readonly lookedAt = new Map<string, number>();
  private readonly headers = new Map<string, SessionHeader>();
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
   * because the run reports that work itself. Only the root file is skipped:
   * a child's work is not in the run's events.
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
   * The child session files of a root: every `.jsonl` file beneath the folder
   * named after the root's file. They are looked up on every call, so a child
   * that omp creates later, or after the root went idle, is found then. Ordered
   * by path, so the same files come out in the same order each time. A child
   * whose session header is still being written is left out until it is whole,
   * so no batch goes out under a provisional identity.
   */
  children(id: string): SessionSource[] {
    this.load();
    const rootFile = this.find(id);
    if (!rootFile) {
      return [];
    }
    const dir = path.dirname(rootFile);
    const folder = path.join(dir, path.basename(rootFile, '.jsonl'));
    return jsonlUnder(folder, 0)
      .sort()
      .flatMap((file) => {
        const header = this.header(file);
        if (!header) {
          return [];
        }
        // The key is root-relative, so a child keeps its position on this machine.
        const relPath = path.relative(dir, file).split(path.sep).join('/');
        return [
          {
            file,
            key: `${id}#${relPath}`,
            sourceSessionId: header.id ?? `file:${relPath}`,
            sourceStartedAt: header.timestamp,
          },
        ];
      });
  }

  /**
   * The id and start of a file's `session` header, found among the complete
   * lines of its first {@link HEADER_BYTES}. Lines before it (omp's title) are
   * skipped. Null while the header is not yet whole, or while the window is
   * not yet full with no header in it (the file may still be being written).
   * Absence is cached only once the full window has been read.
   */
  private header(file: string): SessionHeader | null {
    const known = this.headers.get(file);
    if (known) {
      return known;
    }
    let fd: number | undefined;
    try {
      fd = openSync(file, 'r');
      const chunk = Buffer.alloc(HEADER_BYTES);
      const read = readSync(fd, chunk, 0, chunk.length, 0);
      const found = sessionHeaderIn(chunk.subarray(0, read));
      if (found) {
        this.headers.set(file, found);
        return found;
      }
      if (read < HEADER_BYTES) {
        return null;
      }
      const absent: SessionHeader = {};
      this.headers.set(file, absent);
      return absent;
    } catch {
      return null;
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
      }
    }
  }

  /**
   * The next batch of entries for a session, or null when there is nothing new.
   * A session with no saved position starts at the first line of its file; the
   * server drops what a run already reported.
   */
  next(id: string): ActivityBatch | null {
    this.load();
    const file = this.find(id);
    if (!file) {
      return null;
    }
    return this.read(id, { file, key: id });
  }

  /** The next batch of a child file that {@link children} found for a root. */
  nextFrom(externalId: string, source: SessionSource): ActivityBatch | null {
    this.load();
    return this.read(externalId, source);
  }

  private read(
    externalId: string,
    source: SessionSource,
  ): ActivityBatch | null {
    const { file, key } = source;

    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      if (source.sourceSessionId === undefined) {
        this.paths.delete(externalId);
      }
      return null;
    }

    let offset = this.offsets.get(key);
    if (offset === undefined) {
      offset = 0;
      this.offsets.set(key, offset);
      this.save();
    }
    // A file that became shorter was replaced; start from what it holds now.
    if (offset > size) {
      offset = size;
      this.offsets.set(key, offset);
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
        return batchOf(externalId, source, [], skipped, true);
      }
    }

    if (used === 0) {
      return null;
    }

    return batchOf(externalId, source, entries, offset + used, more);
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
    this.offsets.set(batch.key, batch.nextOffset);
    this.save();
  }
}

/**
 * The first `session` header among the complete lines of some bytes, or null
 * when there is none. Only lines ending in a newline count, so a header that is
 * still being written is not read. Other lines are skipped.
 */
function sessionHeaderIn(bytes: Buffer): SessionHeader | null {
  let start = 0;
  for (;;) {
    const end = bytes.indexOf(0x0a, start);
    if (end === -1) {
      return null;
    }
    const header = parseHeader(bytes.subarray(start, end).toString('utf8'));
    if (header) {
      return header;
    }
    start = end + 1;
  }
}

/** A line as a session header, or null for any other line or one that does not parse. */
function parseHeader(line: string): SessionHeader | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const entry = parsed as Record<string, unknown>;
  if (entry.type !== 'session') {
    return null;
  }
  return {
    id: typeof entry.id === 'string' ? entry.id : undefined,
    timestamp:
      typeof entry.timestamp === 'string' ? entry.timestamp : undefined,
  };
}

/** A batch of one source. Only a child carries its native id and start. */
function batchOf(
  externalId: string,
  source: SessionSource,
  entries: unknown[],
  nextOffset: number,
  more: boolean,
): ActivityBatch {
  return {
    externalId,
    ...(source.sourceSessionId === undefined
      ? {}
      : {
          sourceSessionId: source.sourceSessionId,
          sourceStartedAt: source.sourceStartedAt,
        }),
    entries,
    nextOffset,
    more,
    key: source.key,
  };
}

/** The `.jsonl` files under a folder, down to a fixed depth. */
function jsonlUnder(folder: string, depth: number): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    // No such folder: the root has no children.
    return [];
  }
  return entries.flatMap((entry) => {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      return depth < MAX_CHILD_DEPTH ? jsonlUnder(full, depth + 1) : [];
    }
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [full] : [];
  });
}

/** Keeps the listed keys of an object that are present, with long strings cut. */
function keep(
  source: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in source) {
      kept[key] = cut(source[key]);
    }
  }
  return kept;
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

  if (typeof entry.type !== 'string' || SENT_TYPES[entry.type] !== true) {
    return null;
  }

  if (entry.type === 'model_change') {
    return {
      type: 'model_change',
      ...keep(entry, ['id', 'timestamp', 'model']),
    };
  }

  // An auxiliary model request (a call that is not the session's own message).
  if (entry.type === 'model_usage') {
    return {
      type: 'model_usage',
      ...keep(entry, MODEL_USAGE_KEYS),
    };
  }

  const message = entry.message as Record<string, unknown> | undefined;
  if (typeof message !== 'object' || message === null) {
    return null;
  }

  return {
    type: 'message',
    id: entry.id,
    timestamp: entry.timestamp,
    message: keep(message, MESSAGE_KEYS),
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
