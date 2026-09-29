import type { SandboxSpec } from "@vantikhq/types";

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { missingVmmBinaries, workspaceSizeMb } from "./gondolin";

const spec = (limits: Partial<SandboxSpec["limits"]>): SandboxSpec => ({
  runId: "run-1",
  files: {},
  env: {},
  secrets: {},
  limits: {
    maxDurationMs: 60_000,
    memoryMb: 4096,
    diskMb: 30720,
    cpus: 2,
    maxLogBytes: 1024,
    ...limits,
  },
  egress: { allow: [] },
});

/**
 * The guest's writable area is RAM, so its size is the one number standing
 * between "the harness has somewhere to install" and "the agent is killed by
 * the OOM killer mid-edit". Both ends are worth pinning down.
 */
describe("how much room a run gets to write in", () => {
  it("sizes against memory rather than the disk figure it was handed", () => {
    // 30GB is what the executor asks for, written for a real disk. Honouring
    // it here would let a runaway checkout take the whole guest down.
    expect(workspaceSizeMb(spec({ memoryMb: 4096, diskMb: 30720 }))).toBe(3072);
  });

  it("never hands out more than the caller asked for", () => {
    expect(workspaceSizeMb(spec({ memoryMb: 4096, diskMb: 1024 }))).toBe(1024);
  });

  it("leaves the guest a quarter of its memory to compute in", () => {
    expect(workspaceSizeMb(spec({ memoryMb: 8192, diskMb: 30720 }))).toBe(6144);
  });

  it("keeps enough room for the harness on a small guest", () => {
    // The harness alone unpacks to a little over 200MB, so a figure below this
    // is one that fails at `npx` rather than one that runs in less space.
    expect(workspaceSizeMb(spec({ memoryMb: 256, diskMb: 30720 }))).toBe(512);
    expect(workspaceSizeMb(spec({ memoryMb: 4096, diskMb: 64 }))).toBe(512);
  });
});

describe("whether this server can start a sandbox at all", () => {
  let bin: string;

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "vmm-spec-"));
  });

  afterEach(() => rmSync(bin, { recursive: true, force: true }));

  function install(name: string) {
    writeFileSync(join(bin, name), "#!/bin/sh\n");
    chmodSync(join(bin, name), 0o755);
  }

  it("names each QEMU program that is not on the PATH", () => {
    expect(missingVmmBinaries({ PATH: bin }, "arm64")).toEqual([
      "qemu-img",
      "qemu-system-aarch64",
    ]);
  });

  it("looks for the emulator of the host architecture only", () => {
    install("qemu-img");
    install("qemu-system-aarch64");

    expect(missingVmmBinaries({ PATH: bin }, "arm64")).toEqual([]);
    expect(missingVmmBinaries({ PATH: bin }, "x64")).toEqual([
      "qemu-system-x86_64",
    ]);
  });

  it("does not count a file that cannot be run", () => {
    writeFileSync(join(bin, "qemu-img"), "");

    expect(missingVmmBinaries({ PATH: bin }, "arm64")).toContain("qemu-img");
  });

  it("asks nothing of QEMU when another backend is chosen", () => {
    expect(
      missingVmmBinaries({ PATH: bin, GONDOLIN_VMM: "krun" }, "arm64"),
    ).toEqual([]);
  });
});
