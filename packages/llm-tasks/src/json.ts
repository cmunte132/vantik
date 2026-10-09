/**
 * The first `{` to the last `}` of a model's answer, as an object, or null.
 * Models wrap JSON in prose or a code fence often enough that the object is
 * looked for rather than expected to be the whole answer.
 */
export function parseObject(
  text: string | null,
): Record<string, unknown> | null {
  const answer = text ?? '';
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');

  // No regex here. A regex can take quadratic time on a long answer.
  if (start === -1 || end < start) {
    return null;
  }

  const json = answer.slice(start, end + 1);

  try {
    const value = JSON.parse(json) as unknown;

    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** A trimmed, non-empty string of at most 500 characters, or null. */
export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, 500)
    : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
