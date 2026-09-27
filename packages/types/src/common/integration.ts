export enum IntegrationPayloadEventType {
  /**
   * This is used to identify to which integration account the webhook belongs to
   */
  GET_CONNECTED_ACCOUNT_ID = 'get_connected_account_id',

  SPEC = 'spec',

  /**
   * This is used to create/delete a integration account from the
   * user input
   */
  CREATE = 'create',
  DELETE = 'delete',

  // When the extension gets a external webhook
  SOURCE_WEBHOOK = 'source_webhook',

  // Get a fresh token for the integration
  GET_TOKEN = 'get_token',

  // Valid and return the response for webhooks
  WEBHOOK_RESPONSE = 'webhook_response',

  // Valid and return the response for webhooks
  IS_SUPPORTED_EVENT = 'is_supported_event',

  /**
   * Generic event type for platform-specific actions
   * Example: GitHub specific events, etc.
   */
  PLATFORM_EVENT = 'platform_event',

  /**
   * This asks an integration to describe a webhook as a change to code.
   *
   * The integration returns a `CodeChangeEvent`, or null when the webhook
   * describes something else. The server then routes the change to the modules
   * that own the paths. Only the integration knows the shape of the payload of
   * its own provider, and only the server knows what a module is, so the two
   * meet at this type.
   */
  GET_CODE_CHANGE = 'get_code_change',

  /**
   * This asks an integration for one file of a repository at a commit.
   *
   * The payload's `data` holds `fullName`, `path` and `ref`. The answer is
   * `{ content }`, `{ missing: true }` when the repository answers and the file
   * is not there, or `{ unknown: true, reason }` when the repository cannot be
   * reached. Knowledge citations are checked against the code this way.
   */
  READ_REPO_FILE = 'read_repo_file',

  /**
   * This asks an integration for the commit at the head of a repository's
   * default branch. The payload's `data` holds `fullName`; the answer is
   * `{ sha }` or `{ unknown: true, reason }`.
   */
  RESOLVE_REPO_HEAD = 'resolve_repo_head',
}

/**
 * A change to code, in a form that names no provider.
 *
 * A pull request on GitHub and a merge request on GitLab both become this. The
 * server reads it to find the modules that the change touches.
 */
export interface CodeChangeEvent {
  /** The identifier that the provider gives the repository. */
  externalRepoId: string;
  /** The paths of the files that the change touches. */
  changedPaths: string[];
  /**
   * The issue keys that the change names, such as `ENG-42`. The server checks
   * each one against the teams of the workspace, and it discards a key that
   * matches no issue.
   */
  issueKeys: string[];
  /**
   * The commit the change landed as on the repository's default branch: the
   * merge commit of a merged pull request, or the new head of a push to that
   * branch. Absent for a change that has not landed, such as an open pull
   * request. Knowledge that cites the changed files is checked against it.
   */
  mergeSha?: string;
}

export interface IntegrationEventPayload {
  event: IntegrationPayloadEventType;
  [x: string]: any;
}
