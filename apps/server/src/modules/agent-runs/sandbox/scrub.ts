/**
 * Removes secrets from anything captured out of a sandbox.
 *
 * A backstop, explicitly not the control. The control is that the git token
 * never enters the guest at all, so there is nothing there to leak. This
 * catches the residue: a model key echoed by a verbose installer, a token
 * printed by a misconfigured tool, a stack trace carrying a header.
 *
 * Treating scrubbing as the primary defence is the mistake worth naming. It
 * only works on output you thought to route through it, and a prompt-injected
 * agent has a shell and can exfiltrate over the network without ever printing
 * anything.
 */

/** Replaces every known secret in `text`, longest first. */
export function scrubSecrets(
  text: string,
  secrets: Array<string | null | undefined>,
): string {
  if (!text) {
    return text;
  }

  // Longest first, so a secret that contains another is masked whole rather
  // than shredded into fragments that still reveal its shape.
  const known = secrets
    .filter((secret): secret is string => Boolean(secret && secret.length >= 8))
    .sort((a, b) => b.length - a.length);

  let scrubbed = text;

  for (const secret of known) {
    scrubbed = scrubbed.split(secret).join('[redacted]');

    // Tools frequently url-encode a token into a remote URL, so the literal
    // string never appears but the credential does.
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) {
      scrubbed = scrubbed.split(encoded).join('[redacted]');
    }
  }

  return scrubbed.replace(CREDENTIAL_IN_URL, '$1[redacted]@');
}

/**
 * `https://user:token@host` — the shape a leaked credential most often takes,
 * caught even when the token itself is not one we know about.
 */
const CREDENTIAL_IN_URL = /(\bhttps?:\/\/[^\s/@:]+:)[^\s/@]+@/gi;
