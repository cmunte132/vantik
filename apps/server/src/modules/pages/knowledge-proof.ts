import {
  KnowledgeProof,
  KnowledgeTrustEnum,
  PageEntryCitationCheckEnum,
  PageEntryCitationJudgmentEnum,
  PageEntryCitationKindEnum,
  PageEntryStatusEnum,
  ServedCitation,
} from '@vantikhq/types';

/**
 * What an item of knowledge is served with: how far it can be trusted, what it
 * rests on, and how long ago that was last looked at.
 *
 * One serializer for every path that serves knowledge, so recall, a context
 * pack, a page read and a run's prompt cannot disagree about an entry. Trust
 * is derived from the record each time rather than stored, so it cannot drift
 * from the checks it summarises.
 */

/** The citation columns a proof is built from. */
export const PROOF_CITATION_SELECT = {
  kind: true,
  path: true,
  commitSha: true,
  startLine: true,
  endLine: true,
  targetLabel: true,
  checkedAt: true,
  checkedSha: true,
  checkResult: true,
  judgment: true,
  judgeModel: true,
  moduleRepo: { select: { fullName: true } },
} as const;

export interface ProofCitationRow {
  kind: string;
  path: string | null;
  commitSha: string | null;
  startLine: number | null;
  endLine: number | null;
  targetLabel: string | null;
  checkedAt: Date | null;
  checkedSha: string | null;
  checkResult: string | null;
  judgment: string | null;
  judgeModel: string | null;
  moduleRepo: { fullName: string } | null;
}

/** An entry as a proof is built from it. */
export interface ProofRow {
  status: string;
  verifiedAt: Date | null;
  citations?: ProofCitationRow[] | null;
}

/** Results under which a citation still supports its claim. */
const HOLDING: string[] = [
  PageEntryCitationCheckEnum.HOLDS,
  PageEntryCitationCheckEnum.MOVED,
];

/**
 * An entry's trust tier.
 *
 * A person's confirmation outranks everything. Otherwise an entry is grounded
 * when it was accepted, cites something, and every citation still reads the
 * same, in place or moved. A changed citation is not grounded even when a
 * judge thought the new code still supports the claim: the judge is a model's
 * opinion, and grounded means the text itself was checked. An unread
 * (UNKNOWN) citation never refuses a write or counts as a failed check, but
 * it has not been checked either, so an entry is grounded only once every
 * citation it has has been read and holds.
 */
export function entryTrust(entry: {
  status: string;
  verifiedAt: Date | null;
  citations?: Array<{ checkResult: string | null }> | null;
}): KnowledgeTrustEnum {
  if (entry.verifiedAt) {
    return KnowledgeTrustEnum.HUMAN_VERIFIED;
  }

  const citations = entry.citations ?? [];

  if (
    entry.status === PageEntryStatusEnum.STANDING &&
    citations.length > 0 &&
    citations.every((citation) => HOLDING.includes(citation.checkResult ?? ''))
  ) {
    return KnowledgeTrustEnum.GROUNDED;
  }

  return KnowledgeTrustEnum.UNGROUNDED;
}

export function servedCitation(row: ProofCitationRow): ServedCitation {
  const checked = {
    result: (row.checkResult as PageEntryCitationCheckEnum) ?? null,
    checkedAt: row.checkedAt?.toISOString() ?? null,
    checkedSha: row.checkedSha,
  };

  if (row.kind !== PageEntryCitationKindEnum.CODE) {
    return {
      kind: row.kind as PageEntryCitationKindEnum,
      target: row.targetLabel,
      ...checked,
    };
  }

  return {
    kind: PageEntryCitationKindEnum.CODE,
    repo: row.moduleRepo?.fullName ?? null,
    path: row.path,
    commitSha: row.commitSha,
    lines:
      row.startLine && row.endLine
        ? row.startLine === row.endLine
          ? `${row.startLine}`
          : `${row.startLine}-${row.endLine}`
        : null,
    ...checked,
    ...(row.checkResult === PageEntryCitationCheckEnum.CHANGED && {
      judgment: (row.judgment as PageEntryCitationJudgmentEnum) ?? null,
      judgeModel: row.judgeModel,
    }),
  };
}

/**
 * The proof of an entry. The last check is the latest of any citation; its
 * commit is the latest code check's, since an issue or a run is checked at no
 * commit, and a later look at one does not make the code's commit unknown.
 */
export function entryProof(entry: ProofRow): KnowledgeProof {
  const rows = entry.citations ?? [];
  const newestFirst = rows
    .filter((row) => row.checkedAt)
    .sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime());
  const latestCode = newestFirst.find((row) => row.checkedSha);

  return {
    trust: entryTrust({ ...entry, citations: rows }),
    citations: rows.map(servedCitation),
    lastCheckedAt: newestFirst[0]?.checkedAt.toISOString() ?? null,
    lastCheckedSha: latestCode?.checkedSha ?? null,
  };
}

/**
 * The proof of a page body: narrative a person maintains, not a claim, so it
 * has no tier and nothing to cite.
 */
export function pageBodyProof(): KnowledgeProof {
  return {
    trust: null,
    citations: [],
    lastCheckedAt: null,
    lastCheckedSha: null,
  };
}

const TRUST_WORDS: Record<KnowledgeTrustEnum, string> = {
  [KnowledgeTrustEnum.HUMAN_VERIFIED]: 'verified by a person',
  [KnowledgeTrustEnum.GROUNDED]: 'grounded',
  [KnowledgeTrustEnum.UNGROUNDED]: 'ungrounded',
};

/**
 * A proof in one line of prose, for a reader that is a prompt rather than a
 * program: "grounded · cites acme/api:src/a.ts:40-52 (holds) · checked
 * 2026-09-01 at 1a2b3c4d5e6f".
 */
export function describeProof(proof: KnowledgeProof): string {
  const parts = [proof.trust ? TRUST_WORDS[proof.trust] : 'page narrative'];

  if (proof.citations.length) {
    parts.push(
      `cites ${proof.citations
        .map((citation) => {
          const what =
            citation.kind === PageEntryCitationKindEnum.CODE
              ? `${citation.repo ? `${citation.repo}:` : ''}${citation.path}` +
                `${citation.lines ? `:${citation.lines}` : ''}`
              : `${citation.kind.toLowerCase().replace('_', ' ')} ${citation.target}`;

          return `${what} (${(citation.result ?? 'unchecked').toLowerCase()})`;
        })
        .join(', ')}`,
    );
  } else if (proof.trust) {
    parts.push('cites nothing');
  }

  if (proof.lastCheckedAt) {
    parts.push(
      `checked ${proof.lastCheckedAt.slice(0, 10)}` +
        `${proof.lastCheckedSha ? ` at ${proof.lastCheckedSha.slice(0, 12)}` : ''}`,
    );
  }

  return parts.join(' · ');
}
