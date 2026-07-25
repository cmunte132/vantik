/**
 * Errors thrown by agent-core.
 *
 * Messages are written to be read by an LLM agent as much as by a human: they
 * say what was wrong *and* what to do instead, because the agent's only view of
 * the failure is this string.
 */

export class VantikError extends Error {
  constructor(message: string) {
    super(message);
    // `new.target` is the class actually being constructed, so each subclass
    // reports its own name without restating this constructor to say so.
    this.name = new.target.name;
  }
}

/** The API answered with a non-2xx status. */
export class VantikApiError extends VantikError {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`${method} ${path} failed with ${status}: ${body || '<empty body>'}`);
  }
}

/** The PAT is missing, revoked or rejected. */
export class VantikAuthError extends VantikError {}

/** A supplied reference (issue key, team, state, label) did not resolve. */
export class VantikNotFoundError extends VantikError {}

/** The reference was ambiguous — the caller has to be more specific. */
export class VantikAmbiguousError extends VantikError {}
