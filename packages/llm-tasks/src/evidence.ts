import { redactSecrets } from './redact';

/** A citation as the acceptance judges are shown it. */
export interface EvidenceCitation {
  /** CODE, URL, ISSUE, PULL_REQUEST, COMMENT or RUN. */
  kind: string;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  /** The last check's result, e.g. HOLDS; null when it was never checked. */
  checkResult: string | null;
  snippet: string | null;
  targetLabel: string | null;
  checkedAt: Date | null;
  /** A cited issue's or comment's text, already cut; undefined when not shown. */
  text?: string;
}

/**
 * A citation as the acceptance judges are shown it: the lines as the server
 * read them, or the issue or comment as it reads now. Any credential in them
 * is withheld; the entry passed that check, what it cites did not have to.
 */
export function formatEvidence(citation: EvidenceCitation): string {
  const result = (citation.checkResult ?? 'unchecked').toLowerCase();

  if (citation.kind === 'CODE') {
    const lines =
      citation.startLine && citation.endLine
        ? `:${citation.startLine}-${citation.endLine}`
        : '';

    return `${citation.path ?? '(no path)'}${lines} (${result})\n${
      citation.snippet === null ? '(not read)' : redactSecrets(citation.snippet)
    }`;
  }

  if (citation.kind === 'URL') {
    const read = citation.checkedAt
      ? `, read ${citation.checkedAt.toISOString().slice(0, 10)}`
      : '';

    return `page ${citation.targetLabel ?? '(no URL)'}${read} (${result})\n${
      citation.snippet === null
        ? '(not read)'
        : `"${redactSecrets(citation.snippet)}"`
    }`;
  }

  const label = `${citation.kind.toLowerCase().replace('_', ' ')} ${
    citation.targetLabel ?? '(unknown)'
  } (${result})`;

  return citation.text === undefined
    ? `${label}; its text is not shown`
    : `${label}\n${citation.text}`;
}
