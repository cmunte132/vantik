import type { SandboxExecResult, SandboxTier } from './sandbox';

/**
 * The HTTP contract between the server and the sandbox host.
 *
 * The sandbox host is a separate process that owns the microVMs. The server
 * never starts a VM itself: it asks the sandbox host, over these routes, and
 * the sandbox host keeps each VM's lifetime. So the server can run where no
 * hypervisor is available (a container on macOS, for example), and a server
 * that stops cannot leave a VM that runs for ever.
 *
 * Every route except `health` needs `Authorization: Bearer <token>`, with the
 * token that both sides read from `SANDBOX_HOST_TOKEN`.
 *
 * - `GET    /health`                             liveness, no token
 * - `GET    /v1/availability`                    `SandboxAvailability`
 * - `GET    /v1/sandboxes`                       `SandboxHostSandbox[]`
 * - `POST   /v1/sandboxes`                       `SandboxSpec` → `SandboxHostCreated`
 * - `DELETE /v1/sandboxes/:id`                   204, also when it is gone
 * - `POST   /v1/sandboxes/:id/keepalive`         204; the server holds it still
 * - `POST   /v1/sandboxes/:id/exec`              `SandboxHostExecRequest` → `SandboxHostExecStarted`
 * - `GET    /v1/sandboxes/:id/exec/:execId`      `SandboxHostExecStatus` (`?waitMs=`, `?since=`)
 * - `GET    /v1/sandboxes/:id/files?path=`       the file, as UTF-8 text
 * - `PUT    /v1/sandboxes/:id/files?path=`       the body is the file, as UTF-8 text
 * - `GET    /v1/sandboxes/:id/model-calls`       `SandboxHostModelCalls` (`?since=`)
 *
 * An error is a non-2xx status with a `SandboxHostError` body.
 */
export const SANDBOX_HOST_API_PREFIX = '/v1';

/** The longest one exec poll waits for the command to finish. */
export const SANDBOX_HOST_MAX_WAIT_MS = 30_000;

export interface SandboxHostCreated {
  id: string;
  tier: SandboxTier;
}

export interface SandboxHostSandbox {
  id: string;
  runId: string;
  createdAt: string;
  /** The last time a request named this sandbox. */
  lastTouchedAt: string;
  /** When the sandbox host disposes of it, whatever the server does. */
  deadlineAt: string;
}

export interface SandboxHostExecRequest {
  command: string;
  timeoutMs?: number;
}

export interface SandboxHostExecStarted {
  execId: string;
}

/**
 * Where a command is. A poll with `?waitMs=` waits up to that long, and up to
 * `SANDBOX_HOST_MAX_WAIT_MS`, for the command to finish before it answers.
 *
 * A poll with `?since=<offset>` also asks for the stdout written after that
 * offset. It then answers as soon as there is new output, not only when the
 * command finishes. The host keeps output until a poll asks for a later
 * offset, so a poll whose answer was lost can be sent again with the same
 * offset. `stream.from` is greater than `since` only when the host had to drop
 * output that nobody collected.
 */
export type SandboxHostExecStatus = (
  | { done: false }
  | { done: true; result: SandboxExecResult }
  | { done: true; error: string }
) & { stream?: SandboxHostStream };

export interface SandboxHostStream {
  /** The offset of `text` in the command's stdout. */
  from: number;
  text: string;
}

export interface SandboxHostError {
  error: string;
}
