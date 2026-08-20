import type { SandboxSpec } from './sandbox.interface';

import { workspaceSizeMb } from './gondolin.runtime';

const spec = (limits: Partial<SandboxSpec['limits']>): SandboxSpec => ({
  runId: 'run-1',
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
describe('how much room a run gets to write in', () => {
  it('sizes against memory rather than the disk figure it was handed', () => {
    // 30GB is what the executor asks for, written for a real disk. Honouring
    // it here would let a runaway checkout take the whole guest down.
    expect(workspaceSizeMb(spec({ memoryMb: 4096, diskMb: 30720 }))).toBe(3072);
  });

  it('never hands out more than the caller asked for', () => {
    expect(workspaceSizeMb(spec({ memoryMb: 4096, diskMb: 1024 }))).toBe(1024);
  });

  it('leaves the guest a quarter of its memory to compute in', () => {
    expect(workspaceSizeMb(spec({ memoryMb: 8192, diskMb: 30720 }))).toBe(6144);
  });

  it('keeps enough room for the harness on a small guest', () => {
    // The harness alone unpacks to a little over 200MB, so a figure below this
    // is one that fails at `npx` rather than one that runs in less space.
    expect(workspaceSizeMb(spec({ memoryMb: 256, diskMb: 30720 }))).toBe(512);
    expect(workspaceSizeMb(spec({ memoryMb: 4096, diskMb: 64 }))).toBe(512);
  });
});
