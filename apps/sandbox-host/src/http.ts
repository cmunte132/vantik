import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  SANDBOX_HOST_API_PREFIX,
  SANDBOX_HOST_MAX_WAIT_MS,
  type SandboxHostExecRequest,
  type SandboxRuntime,
  type SandboxSpec,
} from "@vantikhq/types";

import { log } from "./log";
import { NotFoundError, type Sandboxes } from "./sandboxes";

export interface HttpOptions {
  token: string;
  /** The largest request body taken, in bytes. A checkout is sent as one. */
  maxBodyBytes: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The sandbox host's HTTP API. See `@vantikhq/types` `sandbox/protocol.ts`
 * for the routes and their shapes.
 */
export function createSandboxHostServer(
  runtime: SandboxRuntime,
  sandboxes: Sandboxes,
  options: HttpOptions,
): Server {
  const expected = digest(options.token);

  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof NotFoundError
            ? 404
            : 500;
      const message = error instanceof Error ? error.message : String(error);

      if (status === 500) {
        log.error("A request failed", {
          method: request.method,
          path: pathOf(request),
          error: message,
        });
      }

      send(response, status, { error: message });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://sandbox-host");
    const method = request.method ?? "GET";

    if (method === "GET" && url.pathname === "/health") {
      return send(response, 200, { ok: true });
    }

    if (!authorised(request.headers.authorization, expected)) {
      throw new HttpError(401, "A valid sandbox host token is required.");
    }

    if (!url.pathname.startsWith(`${SANDBOX_HOST_API_PREFIX}/`)) {
      throw new HttpError(404, `No route ${method} ${url.pathname}`);
    }

    const parts = url.pathname
      .slice(SANDBOX_HOST_API_PREFIX.length + 1)
      .split("/")
      .map(decodeURIComponent);

    // /availability
    if (parts.length === 1 && parts[0] === "availability" && method === "GET") {
      return send(response, 200, await runtime.availability());
    }

    if (parts[0] !== "sandboxes") {
      throw new HttpError(404, `No route ${method} ${url.pathname}`);
    }

    // /sandboxes
    if (parts.length === 1) {
      if (method === "GET") {
        return send(response, 200, sandboxes.list());
      }

      if (method === "POST") {
        const spec = parseJson<SandboxSpec>(
          await readBody(request, options.maxBodyBytes),
        );

        return send(response, 201, await sandboxes.create(spec));
      }
    }

    const id = parts[1];

    // /sandboxes/:id
    if (parts.length === 2 && method === "DELETE") {
      await sandboxes.dispose(id);
      return send(response, 204);
    }

    // /sandboxes/:id/keepalive
    if (parts.length === 3 && parts[2] === "keepalive" && method === "POST") {
      sandboxes.touch(id);
      return send(response, 204);
    }

    // /sandboxes/:id/exec
    if (parts.length === 3 && parts[2] === "exec" && method === "POST") {
      const body = parseJson<SandboxHostExecRequest>(
        await readBody(request, options.maxBodyBytes),
      );

      if (typeof body.command !== "string" || !body.command) {
        throw new HttpError(400, "An exec needs a command.");
      }

      const execId = sandboxes.startExec(id, body.command, body.timeoutMs);

      return send(response, 202, { execId });
    }

    // /sandboxes/:id/exec/:execId
    if (parts.length === 4 && parts[2] === "exec" && method === "GET") {
      const waitMs = Math.min(
        Math.max(Number(url.searchParams.get("waitMs")) || 0, 0),
        SANDBOX_HOST_MAX_WAIT_MS,
      );
      const sinceParam = url.searchParams.get("since");
      const since = sinceParam === null ? undefined : Number(sinceParam);

      if (since !== undefined && !(Number.isInteger(since) && since >= 0)) {
        throw new HttpError(400, "since must be a whole number, 0 or more.");
      }

      return send(
        response,
        200,
        await sandboxes.waitExec(id, parts[3], waitMs, since),
      );
    }

    // /sandboxes/:id/model-calls?since=
    if (parts.length === 3 && parts[2] === "model-calls" && method === "GET") {
      const since = Number(url.searchParams.get("since") ?? 0);

      if (!(Number.isInteger(since) && since >= 0)) {
        throw new HttpError(400, "since must be a whole number, 0 or more.");
      }

      return send(response, 200, await sandboxes.modelCalls(id, since));
    }

    // /sandboxes/:id/files?path=
    if (parts.length === 3 && parts[2] === "files") {
      const path = url.searchParams.get("path");

      if (!path) {
        throw new HttpError(400, "A file request needs a path.");
      }

      if (method === "GET") {
        return sendText(response, await sandboxes.readFile(id, path));
      }

      if (method === "PUT") {
        await sandboxes.writeFile(
          id,
          path,
          await readBody(request, options.maxBodyBytes),
        );
        return send(response, 204);
      }
    }

    throw new HttpError(404, `No route ${method} ${url.pathname}`);
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Compares digests, so the comparison takes the same time for any token. */
function authorised(header: string | undefined, expected: Buffer): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? "");

  return Boolean(match) && timingSafeEqual(digest(match![1]), expected);
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on("data", (chunk: Buffer) => {
      size += chunk.length;

      if (size > limit) {
        reject(
          new HttpError(413, `The request body is larger than ${limit} bytes.`),
        );
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function parseJson<T>(body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new HttpError(400, "The request body is not JSON.");
  }
}

function send(response: ServerResponse, status: number, body?: unknown) {
  if (response.headersSent) {
    return;
  }

  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }

  response
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(body));
}

function sendText(response: ServerResponse, text: string) {
  response
    .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
    .end(text);
}

/** The path without the query, which can hold a file name from the guest. */
function pathOf(request: IncomingMessage): string {
  return (request.url ?? "").split("?")[0];
}
