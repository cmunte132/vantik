/**
 * What an entry's claim rests on.
 *
 * A claim about code cites the code, at a commit, so it can be checked against
 * the code rather than against the model that wrote it. A decision cites where
 * it was decided. Either way the evidence lives outside the entry's text, and
 * is checked by the server rather than taken on the writer's word.
 */
export enum PageEntryCitationKindEnum {
  /** Lines of a file in a module's repository, at a commit. */
  CODE = 'CODE',
  /** An issue in the workspace. */
  ISSUE = 'ISSUE',
  /** A pull request linked to an issue in the workspace. */
  PULL_REQUEST = 'PULL_REQUEST',
  /** A comment on an issue in the workspace. */
  COMMENT = 'COMMENT',
  /** An agent run in the workspace. */
  RUN = 'RUN',
}

/**
 * The result of the last check of a citation.
 *
 * Decided by comparing content, never by asking a model: a snippet at the same
 * lines holds, the same snippet elsewhere in the file moved, and anything else
 * changed. Only a changed citation is put to a model, and its answer is kept
 * beside this rather than replacing it.
 */
export enum PageEntryCitationCheckEnum {
  /** The cited lines read the same. For a non-code citation: it exists. */
  HOLDS = 'HOLDS',
  /** The cited lines read the same somewhere else in the file. */
  MOVED = 'MOVED',
  /** The cited lines are no longer in the file. */
  CHANGED = 'CHANGED',
  /** The file, or the non-code target, is gone. */
  MISSING = 'MISSING',
  /** The source could not be reached. Retried later; never a failure. */
  UNKNOWN = 'UNKNOWN',
}

/** What a judge said about a changed citation. */
export enum PageEntryCitationJudgmentEnum {
  /** The current code still supports the claim. */
  HOLDS = 'HOLDS',
  /** The current code contradicts the claim. */
  CONTRADICTED = 'CONTRADICTED',
  /** The judge could not tell, or no model is configured. */
  UNCLEAR = 'UNCLEAR',
}

/**
 * How much an entry can be trusted, derived from its record rather than
 * stored, so it cannot drift from the facts it summarises.
 */
export enum KnowledgeTrustEnum {
  /** A person confirmed it. */
  HUMAN_VERIFIED = 'HUMAN_VERIFIED',
  /** Accepted, cited, and every citation still holds. */
  GROUNDED = 'GROUNDED',
  /** Anything else. */
  UNGROUNDED = 'UNGROUNDED',
}

export class PageEntryCitation {
  id: string;
  createdAt: Date;
  updatedAt: Date;

  entryId: string;
  kind: PageEntryCitationKindEnum;

  moduleRepoId: string | null;
  path: string | null;
  commitSha: string | null;
  startLine: number | null;
  endLine: number | null;
  snippet: string | null;
  snippetHash: string | null;

  targetId: string | null;
  targetLabel: string | null;

  checkedAt: Date | null;
  checkedSha: string | null;
  checkResult: PageEntryCitationCheckEnum | null;

  judgment: PageEntryCitationJudgmentEnum | null;
  judgeModel: string | null;
  judgeLines: string | null;
  judgeReason: string | null;
}

/**
 * A citation as it is served with knowledge: enough for a reader to open the
 * evidence and see how old the last check of it is.
 */
export interface ServedCitation {
  kind: PageEntryCitationKindEnum;
  /** CODE: the repository's full name. */
  repo?: string | null;
  /** CODE: the path, relative to the repository root. */
  path?: string | null;
  /** CODE: the commit the lines were cited at. */
  commitSha?: string | null;
  /** CODE: the cited lines, e.g. "40-52", at the last check. */
  lines?: string | null;
  /** Non-code: the issue key, pull request URL, or comment or run id. */
  target?: string | null;
  result: PageEntryCitationCheckEnum | null;
  checkedAt: string | null;
  checkedSha: string | null;
  /** CHANGED only: what the judge said, and which model said it. */
  judgment?: PageEntryCitationJudgmentEnum | null;
  judgeModel?: string | null;
}

/** The proof served with every item of knowledge. */
export interface KnowledgeProof {
  /** Null for a page body, which is narrative rather than a claim. */
  trust: KnowledgeTrustEnum | null;
  citations: ServedCitation[];
  /** The most recent check of any citation, and the commit it was made at. */
  lastCheckedAt: string | null;
  lastCheckedSha: string | null;
}
