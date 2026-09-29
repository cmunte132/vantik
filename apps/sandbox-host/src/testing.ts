import type {
  SandboxExecResult,
  SandboxHandle,
  SandboxRuntime,
  SandboxSpec,
} from "@vantikhq/types";

/** A runtime that boots nothing, for the tests of what sits around it. */
export class FakeRuntime implements SandboxRuntime {
  readonly name = "fake";
  readonly handles: FakeHandle[] = [];
  available = true;

  async availability() {
    return this.available
      ? { available: true, tier: "microvm" as const }
      : { available: false, reason: "no hypervisor here" };
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const handle = new FakeHandle(spec);
    this.handles.push(handle);
    return handle;
  }
}

export class FakeHandle implements SandboxHandle {
  readonly tier = "microvm" as const;
  readonly files = new Map<string, string>();
  disposed = 0;
  /** Settles a pending exec; set by the test to control when it finishes. */
  release?: (result: SandboxExecResult) => void;
  lastTimeoutMs?: number;

  constructor(readonly spec: SandboxSpec) {}

  get id() {
    return this.spec.runId;
  }

  exec(
    command: string,
    options: { timeoutMs?: number } = {},
  ): Promise<SandboxExecResult> {
    this.lastTimeoutMs = options.timeoutMs;

    if (command === "fail") {
      return Promise.reject(new Error("the guest went away"));
    }

    if (command === "wait") {
      return new Promise((resolve) => {
        this.release = resolve;
      });
    }

    return Promise.resolve({
      exitCode: 0,
      stdout: command,
      stderr: "",
      egressDenied: 0,
    });
  }

  async readFile(path: string) {
    const contents = this.files.get(path);

    if (contents === undefined) {
      throw new Error(`no file ${path}`);
    }
    return contents;
  }

  async writeFile(path: string, contents: string) {
    this.files.set(path, contents);
  }

  async dispose() {
    this.disposed += 1;
  }
}

export function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    runId: "run-1",
    files: {},
    env: {},
    secrets: {
      MODEL_API_KEY: { value: "sk-real-model-key-1234567890", hosts: ["x.ai"] },
    },
    limits: {
      maxDurationMs: 60_000,
      memoryMb: 1024,
      diskMb: 1024,
      cpus: 1,
      maxLogBytes: 1024,
    },
    egress: { allow: [] },
    ...overrides,
  };
}
