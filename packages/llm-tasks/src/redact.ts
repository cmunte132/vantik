/**
 * Shapes a credential takes. Each is specific enough that ordinary prose does
 * not match it: a provider's key prefix with the length that follows it, a
 * private key's armour, a password in a URL. Precision matters more than
 * reach here, because a match refuses the write; an unusual secret that slips
 * past is still text a person reviews before it is served.
 */
export const SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> =
  [
    {
      name: 'private key',
      pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/,
    },
    { name: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,})\b/ },
    {
      name: 'GitHub token',
      pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
    },
    { name: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
    { name: 'Slack token', pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}\b/ },
    {
      name: 'model provider key',
      pattern: /\bsk-(?:ant-|or-|proj-)?[A-Za-z0-9_-]{20,}\b/,
    },
    { name: 'Stripe key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/ },
    { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
    {
      name: 'JSON web token',
      pattern:
        /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
    },
    {
      name: 'credential in a URL',
      pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@[^\s/]+/i,
    },
    { name: 'Vantik token', pattern: /\btg_pat_[A-Za-z0-9_-]{16,}\b/ },
  ];

/** The kind of credential the content seems to hold, or null. */
export function secretIn(content: string): string | null {
  return (
    SECRET_PATTERNS.find(({ pattern }) => pattern.test(content ?? ''))?.name ??
    null
  );
}

/**
 * The text with every credential in it replaced by what kind it was.
 *
 * For text triage shows a model but did not refuse: a neighbour written before
 * writes were checked, the lines a citation points at, the issue it names. The
 * claim is still judged; the credential goes no further than it already has.
 */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, { name, pattern }) =>
      redacted.replace(
        new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`),
        `[withheld: ${name}]`,
      ),
    text ?? '',
  );
}
