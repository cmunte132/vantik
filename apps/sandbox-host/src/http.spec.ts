import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSandboxHostServer } from "./http";
import { Sandboxes } from "./sandboxes";
import { FakeRuntime, spec } from "./testing";

const TOKEN = "a-sandbox-host-token-long-enough";

let runtime: FakeRuntime;
let server: Server;
let base: string;

beforeEach(async () => {
  runtime = new FakeRuntime();
  server = createSandboxHostServer(
    runtime,
    new Sandboxes(runtime, { idleMs: 60_000, graceMs: 0 }),
    { token: TOKEN, maxBodyBytes: 1024 * 1024 },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

function call(path: string, init: RequestInit = {}, token = TOKEN) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
}

async function create(): Promise<string> {
  const response = await call("/v1/sandboxes", {
    method: "POST",
    body: JSON.stringify(spec()),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

describe("the token", () => {
  it("is not needed for the health check", async () => {
    expect((await call("/health", {}, "")).status).toBe(200);
  });

  it.each([
    ["GET", "/v1/availability"],
    ["GET", "/v1/sandboxes"],
    ["POST", "/v1/sandboxes"],
    ["DELETE", "/v1/sandboxes/x"],
    ["POST", "/v1/sandboxes/x/exec"],
    ["GET", "/v1/sandboxes/x/files?path=a"],
  ])("is refused when missing or wrong on %s %s", async (method, path) => {
    expect((await call(path, { method }, "")).status).toBe(401);
    expect((await call(path, { method }, "wrong-token")).status).toBe(401);
  });

  it("starts no sandbox for a request without it", async () => {
    await call("/v1/sandboxes", { method: "POST", body: "{}" }, "");

    expect(runtime.handles).toHaveLength(0);
  });
});

describe("the routes", () => {
  it("says whether this host can start a sandbox, and why not", async () => {
    runtime.available = false;

    const response = await call("/v1/availability");

    await expect(response.json()).resolves.toEqual({
      available: false,
      reason: "no hypervisor here",
    });
  });

  it("runs a command by starting it and polling for the result", async () => {
    const id = await create();

    const started = await call(`/v1/sandboxes/${id}/exec`, {
      method: "POST",
      body: JSON.stringify({ command: "wait" }),
    });
    expect(started.status).toBe(202);
    const { execId } = (await started.json()) as { execId: string };

    const pending = await call(`/v1/sandboxes/${id}/exec/${execId}?waitMs=0`);
    await expect(pending.json()).resolves.toEqual({ done: false });

    runtime.handles[0].release!({
      exitCode: 0,
      stdout: "done",
      stderr: "",
      egressDenied: 0,
    });

    const finished = await call(
      `/v1/sandboxes/${id}/exec/${execId}?waitMs=5000`,
    );
    await expect(finished.json()).resolves.toMatchObject({
      done: true,
      result: { stdout: "done" },
    });
  });

  it("writes and reads a file as plain text", async () => {
    const id = await create();
    const contents = "a large checkout, base64\n".repeat(1000);

    const written = await call(
      `/v1/sandboxes/${id}/files?path=${encodeURIComponent("repo.tar.gz.b64")}`,
      { method: "PUT", body: contents },
    );
    expect(written.status).toBe(204);

    const read = await call(`/v1/sandboxes/${id}/files?path=repo.tar.gz.b64`);
    await expect(read.text()).resolves.toBe(contents);
  });

  it("refuses a body over the limit", async () => {
    const id = await create();

    const response = await call(`/v1/sandboxes/${id}/files?path=big`, {
      method: "PUT",
      body: "x".repeat(2 * 1024 * 1024),
    }).catch((): undefined => undefined);

    // The connection may close before the answer arrives; either way the
    // file is not written.
    if (response) {
      expect(response.status).toBe(413);
    }
    expect(runtime.handles[0].files.has("big")).toBe(false);
  });

  it("disposes of a sandbox, and answers the same when it is already gone", async () => {
    const id = await create();

    expect(
      (await call(`/v1/sandboxes/${id}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect(
      (await call(`/v1/sandboxes/${id}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect(runtime.handles[0].disposed).toBe(1);
  });

  it("answers 404 for a sandbox it does not hold", async () => {
    const response = await call("/v1/sandboxes/nope/keepalive", {
      method: "POST",
    });

    expect(response.status).toBe(404);
  });
});

describe("secrets", () => {
  it("never appear in a response or in the log", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    try {
      const id = await create();
      const bodies = await Promise.all(
        ["/v1/sandboxes", `/v1/sandboxes/${id}/files?path=missing`].map(
          async (path) => (await call(path)).text(),
        ),
      );
      await call(`/v1/sandboxes/${id}`, { method: "DELETE" });

      const logged = [...out.mock.calls, ...err.mock.calls]
        .map((args) => String(args[0]))
        .join("\n");

      for (const text of [...bodies, logged]) {
        expect(text).not.toContain("sk-real-model-key-1234567890");
      }
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
