/**
 * One of Vantik's built-in LLM tasks: what it asks and how its answer is read.
 *
 * A task is text in and text out. It holds no client, no model id and no
 * key, so the server can run it on whatever the host configured, and the
 * evals can run the same prompt against any candidate model and read the
 * answer with the same parser the server uses.
 */

/**
 * Which of the host's models a task is meant to run on.
 *
 * `decisions` is a task whose answer is a choice between named options;
 * `default` is everything else. The server still maps tasks to its
 * `fast`/`smart` roles; this is the mapping the evals measure against.
 */
export type LLMTier = 'default' | 'decisions';

export interface LLMTask<Input, Answer> {
  /** The `purpose` the server logs the call under. */
  purpose: string;
  tier: LLMTier;
  /** The temperature the server asks at; undefined leaves the model's own. */
  temperature: number | undefined;
  system: string;
  prompt(input: Input): string;
  /** The answer, or null when there is none that can be read. */
  parse(text: string, input: Input): Answer | null;
}
