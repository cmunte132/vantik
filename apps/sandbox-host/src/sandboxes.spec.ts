import { beforeEach, describe, expect, it } from "vitest";

import { NotFoundError, Sandboxes } from "./sandboxes";
import { FakeRuntime, spec } from "./testing";

let now: number;
let runtime: FakeRuntime;
let sandboxes: Sandboxes;

beforeEach(() => {
  now = 1_000_000;
  runtime = new FakeRuntime();
  sandboxes = new Sandboxes(runtime, {
    idleMs: 5_000,
    graceMs: 1_000,
    now: () => now,
  });
});

describe("how long a sandbox lives", () => {
  it("is disposed of at its deadline, even while the server still asks for it", async () => {
    const { id } = await sandboxes.create(spec());

    now += 59_000;
    sandboxes.touch(id);
    await sandboxes.sweep();
    expect(runtime.handles[0].disposed).toBe(0);

    now += 2_000;
    sandboxes.touch(id);
    await sandboxes.sweep();
    expect(runtime.handles[0].disposed).toBe(1);
    expect(sandboxes.list()).toEqual([]);
  });

  it("is disposed of when no request comes for it, as after a server crash", async () => {
    const { id } = await sandboxes.create(spec());

    now += 4_000;
    sandboxes.touch(id);
    now += 4_000;
    await sandboxes.sweep();
    expect(runtime.handles[0].disposed).toBe(0);

    now += 1_000;
    await sandboxes.sweep();
    expect(runtime.handles[0].disposed).toBe(1);
  });

  it("can be disposed of twice, and forgets it the first time", async () => {
    const { id } = await sandboxes.create(spec());

    await sandboxes.dispose(id);
    await sandboxes.dispose(id);

    expect(runtime.handles[0].disposed).toBe(1);
    expect(() => sandboxes.touch(id)).toThrow(NotFoundError);
  });

  it("lists each sandbox with the run it belongs to", async () => {
    await sandboxes.create(spec({ runId: "run-7" }));

    expect(sandboxes.list()).toEqual([
      expect.objectContaining({
        runId: "run-7",
        deadlineAt: new Date(now + 61_000).toISOString(),
      }),
    ]);
  });
});

describe("a command", () => {
  it("starts at once and gives its result to a later poll", async () => {
    const { id } = await sandboxes.create(spec());
    const execId = sandboxes.startExec(id, "wait");

    await expect(sandboxes.waitExec(id, execId, 0)).resolves.toEqual({
      done: false,
    });

    runtime.handles[0].release!({
      exitCode: 3,
      stdout: "out",
      stderr: "err",
      egressDenied: 2,
    });

    await expect(sandboxes.waitExec(id, execId, 1_000)).resolves.toEqual({
      done: true,
      result: { exitCode: 3, stdout: "out", stderr: "err", egressDenied: 2 },
    });
  });

  it("is given out once, then forgotten", async () => {
    const { id } = await sandboxes.create(spec());
    const execId = sandboxes.startExec(id, "echo");

    await sandboxes.waitExec(id, execId, 1_000);

    await expect(sandboxes.waitExec(id, execId, 0)).rejects.toThrow(
      NotFoundError,
    );
  });

  it("reports a command that threw as an error, not as an exit code", async () => {
    const { id } = await sandboxes.create(spec());
    const execId = sandboxes.startExec(id, "fail");

    await expect(sandboxes.waitExec(id, execId, 1_000)).resolves.toEqual({
      done: true,
      error: "the guest went away",
    });
  });

  it("never runs past the sandbox deadline, whatever timeout it asked for", async () => {
    const { id } = await sandboxes.create(spec());

    now += 50_000;
    sandboxes.startExec(id, "echo", 3_600_000);

    expect(runtime.handles[0].lastTimeoutMs).toBe(11_000);
  });

  it("keeps the sandbox alive while the server polls it", async () => {
    const { id } = await sandboxes.create(spec());
    const execId = sandboxes.startExec(id, "wait");

    for (let poll = 0; poll < 5; poll++) {
      now += 4_000;
      await sandboxes.waitExec(id, execId, 0);
      await sandboxes.sweep();
    }

    expect(runtime.handles[0].disposed).toBe(0);
  });
});
