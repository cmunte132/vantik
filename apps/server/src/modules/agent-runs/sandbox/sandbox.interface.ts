/**
 * The isolation boundary a hosted run executes inside.
 *
 * Deliberately narrow, and deliberately **not** satisfiable by a plain
 * container. A container is a packaging and resource-management tool that
 * happens to isolate; it shares the host kernel, and "it runs in a container"
 * says almost nothing about what a hostile or merely confused agent can reach.
 * We are running model-driven code that writes and executes arbitrary
 * commands, which is close to the worst case a container runtime is asked to
 * hold.
 *
 * So the accepted tiers are a microVM or gVisor, with any container runtime
 * living *inside* that boundary rather than being it. An install that cannot
 * provide one is refused the hosted executor rather than silently downgraded —
 * a weaker sandbox that nobody was told about is worse than no sandbox, because
 * the threat model on paper stops matching the one in production.
 *
 * The threat model to hold in mind: the adversary is not only a malicious
 * user, it is a capable agent that has been prompt-injected by content in the
 * repository or the issue it was asked to work on. It has shell access by
 * design. Defences that assume the agent cooperates are not defences.
 */
export type SandboxTier = 'microvm' | 'gvisor';

export interface SandboxAvailability {
  available: boolean;
  /** Which boundary this host can actually provide. */
  tier?: SandboxTier;
  /** Why not, phrased for someone who has to go and fix it. */
  reason?: string;
}

export interface SandboxLimits {
  /** Enforced by the runtime, not by application code a runaway can outlive. */
  maxDurationMs: number;
  memoryMb: number;
  diskMb: number;
  cpus: number;
  /** Bytes of captured output kept before the rest is dropped. */
  maxLogBytes: number;
}

/**
 * Hosts a guest may reach.
 *
 * Enforced by something the guest cannot reconfigure — a filtering proxy or a
 * network namespace it does not control — rather than by container network
 * flags it could undo. Everything not on the list is refused and *recorded*: a
 * spike in denials is the clearest prompt-injection signal available, so it is
 * a signal to surface rather than noise to suppress.
 */
export interface EgressPolicy {
  allow: string[];
}

/**
 * A credential the guest needs the *effect* of, but must never hold.
 *
 * The runtime puts a placeholder in the guest's environment and swaps the real
 * value in host-side, on outbound requests to `hosts` and nowhere else. So the
 * agent can call the model, while `echo $MODEL_API_KEY` inside the guest yields
 * a meaningless token — and a prompt-injected agent that exfiltrates its whole
 * environment exfiltrates nothing.
 *
 * This is the control that actually defeats prompt injection. A sandbox stops
 * the agent rooting the host; only credential separation stops it giving away
 * the key it was handed.
 */
export interface SandboxSecret {
  value: string;
  /** The only hosts the real value is ever substituted into. */
  hosts: string[];
}

export interface SandboxSpec {
  runId: string;
  /** Files to seed the guest with, keyed by path relative to /workspace. */
  files: Record<string, string>;
  /**
   * Plain environment the guest may read in full. Nothing secret belongs here.
   */
  env: Record<string, string>;
  /**
   * Host-substituted credentials, keyed by the environment variable name the
   * guest sees a placeholder under.
   *
   * The git token is deliberately absent and there is no field for it. Push and
   * pull-request creation happen host-side on the guest's request, so the guest
   * has neither the token nor a placeholder standing in for one.
   */
  secrets: Record<string, SandboxSecret>;
  limits: SandboxLimits;
  egress: EgressPolicy;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Egress attempts the policy refused during this command. */
  egressDenied: number;
}

/**
 * A running guest.
 *
 * `dispose` must be safe to call twice and must leave nothing behind — no VM,
 * no checkout, no decrypted secret. It is called on success, on failure, on
 * cancel, and during startup reconciliation after a server restart.
 */
export interface SandboxHandle {
  readonly id: string;
  readonly tier: SandboxTier;
  exec(command: string, options?: { timeoutMs?: number }): Promise<SandboxExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface SandboxRuntime {
  readonly name: string;
  availability(): Promise<SandboxAvailability>;
  create(spec: SandboxSpec): Promise<SandboxHandle>;
}
