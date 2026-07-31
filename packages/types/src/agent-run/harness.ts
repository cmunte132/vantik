/**
 * The pinned harness build.
 *
 * Pinned rather than floating, and recorded on every run alongside the model
 * id. Two runs of the same issue are only comparable if you know what drove
 * them, and "latest" is not an answer to that question three weeks later.
 *
 * Here rather than beside either runner because both use it. The hosted
 * executor used to spell the package out unpinned while the BYO runner pinned
 * it, so the same issue delegated two ways could run two different builds and
 * nothing recorded the difference.
 */
export const PI_VERSION = '0.82.1';
export const PI_PACKAGE = `@earendil-works/pi-coding-agent@${PI_VERSION}`;

/**
 * The flags Pi is always given, whatever else a run asks for.
 *
 * `--no-extensions` is a security control, not a preference: Pi otherwise
 * auto-discovers extensions from `.pi/extensions/*.ts` **in the project
 * directory** and executes them with full system access — which, for an agent
 * pointed at arbitrary repositories, is a code-execution path controlled by
 * whoever can land a file in the repo.
 *
 * `--no-skills` is the same control one layer up. A skill is markdown that
 * instructs the model, and the standard lets one carry helper scripts the
 * model is told to run — so a skill discovered from `.pi/skills/` or
 * `.agents/skills/` in the checkout is, again, whoever can land a file in the
 * repository writing the agent's instructions. Discovery off, and the skills
 * a run should have are passed explicitly with `--skill`, which stays additive
 * under this flag.
 *
 * `--no-approve` is not security but necessity: there is no human present to
 * approve a tool call, and a harness blocked on a prompt burns its lease
 * waiting for one.
 *
 * `--mode json` is what a sandbox needs and `--mode rpc` is not. RPC is a
 * server: it answers prompts sent as JSONL commands on stdin and waits for the
 * next one, so nothing about finishing the work makes it exit. The hosted
 * executor has one shot at a command and reads the result afterwards, so it
 * wants the mode that takes a prompt as an argument, streams its events and
 * then terminates. The BYO runner keeps RPC, because it drives the process
 * interactively and closes stdin itself.
 *
 * None of these is configurable, and nothing in the settings UI offers to
 * change them.
 */
export const PI_REQUIRED_FLAGS = [
  '--mode',
  'json',
  '--no-extensions',
  '--no-skills',
  '--no-approve',
] as const;

/**
 * A model or provider id that is safe to put in a command line.
 *
 * These reach a shell. Model ids are letters, digits and the handful of
 * separators providers actually use (`gpt-4.1`, `claude-opus-4-5-20260315`,
 * `anthropic/claude-opus-4.5` on OpenRouter, `meta-llama/Llama-3.3-70B:free`),
 * so anything outside that set is refused rather than escaped — a quoting bug
 * here is command execution, and there is no legitimate id it would reject.
 */
export function isSafeModelId(value: string): boolean {
  return /^[A-Za-z0-9._:@/-]{1,200}$/.test(value);
}
