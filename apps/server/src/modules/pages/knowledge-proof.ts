import {
  KnowledgeProof,
  KnowledgeTrustEnum,
  PageEntryCitationCheckEnum,
  PageEntryCitationJudgmentEnum,
  PageEntryCitationKindEnum,
  PageEntryStatusEnum,
  ServedCitation,
} from '@vantikhq/types';

import { OBSERVED_RECHECK_MS } from './outside-source';

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

/**
 * Statuses of an accepted entry: standing, or folded into a page body by a
 * person accepting the consolidation, and kept as that body's evidence.
 */
const ACCEPTED: string[] = [
  PageEntryStatusEnum.STANDING,
  PageEntryStatusEnum.CONSOLIDATED,
];

/** Results under which a citation still supports its claim. */
const HOLDING: string[] = [
  PageEntryCitationCheckEnum.HOLDS,
  PageEntryCitationCheckEnum.MOVED,
];

/**
 * How long an observation of an outside page counts. The gardener reads the
 * page again after `OBSERVED_RECHECK_MS`. If the page does not answer for as
 * long again, the observation is too old to serve as observed.
 */
export const OBSERVED_STALE_MS = 2 * OBSERVED_RECHECK_MS;

/**
 * An entry's trust tier.
 *
 * A person's confirmation outranks everything. Otherwise an entry is grounded
 * when it was accepted (standing, or consolidated into a page body, which
 * does not make its citations any less checked), cites something, and every
 * citation still reads the
 * same, in place or moved. A changed citation is not grounded even when a
 * judge thought the new code still supports the claim: the judge is a model's
 * opinion, and grounded means the text itself was checked. An unread
 * (UNKNOWN) citation never refuses a write or counts as a failed check, but
 * it has not been checked either, so an entry is grounded only once every
 * citation it has has been read and holds.
 *
 * An entry that rests on an outside page, and whose citations all hold, is
 * observed and not grounded: the server read the page on a date, and a page
 * can change with no commit to show it. An observation older than
 * `OBSERVED_STALE_MS` does not hold.
 */
export function entryTrust(
  entry: {
    status: string;
    verifiedAt: Date | null;
    citations?: Array<{
      kind: string;
      checkResult: string | null;
      checkedAt: Date | null;
    }> | null;
  },
  now: Date = new Date(),
): KnowledgeTrustEnum {
  if (entry.verifiedAt) {
    return KnowledgeTrustEnum.HUMAN_VERIFIED;
  }

  const citations = entry.citations ?? [];

  if (
    !ACCEPTED.includes(entry.status) ||
    citations.length === 0 ||
    !citations.every((citation) => HOLDING.includes(citation.checkResult ?? ''))
  ) {
    return KnowledgeTrustEnum.UNGROUNDED;
  }

  const pages = citations.filter(
    (citation) => citation.kind === PageEntryCitationKindEnum.URL,
  );

  if (pages.length === 0) {
    return KnowledgeTrustEnum.GROUNDED;
  }

  return pages.every(
    (citation) =>
      citation.checkedAt &&
      now.getTime() - citation.checkedAt.getTime() <= OBSERVED_STALE_MS,
  )
    ? KnowledgeTrustEnum.OBSERVED
    : KnowledgeTrustEnum.UNGROUNDED;
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
  [KnowledgeTrustEnum.OBSERVED]: 'observed',
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
              : citation.kind === PageEntryCitationKindEnum.URL
                ? `page ${citation.target}${
                    citation.checkedAt
                      ? `, read ${citation.checkedAt.slice(0, 10)}`
                      : ''
                  }`
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
