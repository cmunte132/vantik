/**
 * Reads a markdown body from stdin when an option is given as `-`.
 *
 * A project description is a document, not a flag value: it has blank lines,
 * headings and shell metacharacters, and quoting one onto an argv is how you
 * get a mangled description. `--description -` lets it arrive over a pipe
 * intact — the convention `git`, `gh` and friends already use.
 */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }

  // Trailing newline only — leading whitespace in markdown is meaningful, and
  // a heredoc that ends with a newline should not become a description that
  // ends with a blank line.
  return Buffer.concat(chunks).toString('utf8').replace(/\n+$/, '');
}

/**
 * Resolves an option that may be the literal `-`, meaning "read it from
 * stdin". Left alone otherwise, including when absent.
 */
export async function resolveBody(
  value: string | undefined,
): Promise<string | undefined> {
  return value === '-' ? await readStdin() : value;
}
