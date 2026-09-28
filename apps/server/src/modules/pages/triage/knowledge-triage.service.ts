import { createHash, randomUUID } from 'node:crypto';

import { Injectable, Optional } from '@nestjs/common';
import {
  KnowledgeEscalationReason,
  KnowledgeTriageDecisionType,
  KnowledgeTriageMode,
  KnowledgeTriagePolicy,
  PageEntryCitationKind,
  PageEntryKind,
  PageEntryPolicy,
  PageEntryRelationDecider,
  PageEntryRelationType,
  PageEntryStatus,
  Prisma,
  UserType,
} from '@prisma/client';
import { KnowledgeTrustEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { convertTiptapJsonToText } from 'common/utils/tiptap.utils';

import { LoggerService } from 'modules/logger/logger.service';
import { VectorService } from 'modules/vector/vector.service';

import KnowledgeIndexService from '../knowledge-index.service';
import { entryTrust } from '../knowledge-proof';
import { knowledgeSettings } from '../knowledge-settings';
import { contentHashOf } from '../page-entries.service';
import { auditDraw, isActing } from './agreement';
import { backoffState, type BackoffState } from './knowledge-agreement.service';
import { preferred } from './precedence';
import { factualDifference } from './relation-guard';
import TriageJudges, {
  type AcceptJudgment,
  type PairJudgment,
} from './triage-judges';
import {
  commentSourceOf,
  externalSourceOf,
  redactSecrets,
  secretIn,
  severalClaimsIn,
} from './triage-policy';
import { answerGaps } from '../upkeep/gap-answers';

/**
 * Decides what becomes of a new entry before a person looks at it.
 *
 * One pass per entry, in a fixed order, cheapest and most certain first:
 *
 * 1. policy: a credential or several claims in one entry is refused outright,
 *    and an entry that rests on text from outside the workspace, through a
 *    run its writer was in or what it cites, is marked for a person before
 *    any model sees it;
 * 2. an exact repeat, found by hash, corroborates the entry it repeats;
 * 3. the nearest entries in the same modules are related to it, by a rule in
 *    code where the two differ in a number, date, negation or condition, and
 *    otherwise by two model judgments that must agree;
 * 4. acceptance: an agent's entry is not accepted without a person (see
 *    `writerOf`); every citation must hold, and an entry that cites nothing
 *    is not grounded;
 * 5. the decision, and in `on` mode, acting on it. A decision of a type
 *    whose agreement with people has fallen under the floor escalates
 *    instead (see `KnowledgeAgreementService`), and a share of what is acted
 *    on is drawn for a person to audit.
 *
 * Anything the pass cannot settle escalates with every reason that applied,
 * and nothing is accepted on a check that did not run: with no model, the
 * rules and the hash still decide what they can, and the rest waits for a
 * person. Precedence between contradicting entries is decided here, in code;
 * a model only reports that two entries contradict.
 *
 * Every decision is recorded with what it was decided on, in shadow mode too,
 * where it changes nothing. That record is how the automation is measured,
 * and how a person can see why an entry was accepted without them.
 */

/** How many of the nearest entries a new one is compared with. */
export const MAX_NEIGHBOURS = 3;

/**
 * As many modules as one fact is about. A scope over more than this is a
 * claim about most of a codebase, which every run in each of them would be
 * handed; a person decides whether it is true that widely. So does an entry
 * with no scope at all, which is served to every query.
 */
export const BROAD_SCOPE_MODULES = 3;

/** How much of a cited issue or comment the acceptance judges are shown. */
export const MAX_CITED_TEXT = 1_500;

/** Results under which a citation still supports its claim. */
const HOLDING = new Set<string>(['HOLDS', 'MOVED']);

/** Served entries: standing, or consolidated as a page's evidence. */
const SERVED: PageEntryStatus[] = [
  PageEntryStatus.STANDING,
  PageEntryStatus.CONSOLIDATED,
];

/** What a new entry is compared with: what is waiting, and what is served. */
const NEIGHBOUR_STATUSES: PageEntryStatus[] = [
  PageEntryStatus.PROPOSED,
  ...SERVED,
];

function isServed(status: string): status is PageEntryStatus {
  return (SERVED as string[]).includes(status);
}

/** What a triage pass decided, as its caller logs it. */
export interface TriageOutcome {
  decisionId: string;
  decision: KnowledgeTriageDecisionType;
  reasons: KnowledgeEscalationReason[];
  policy: KnowledgeTriagePolicy | null;
  mode: KnowledgeTriageMode;
  applied: boolean;
  /** The decision it reached, when its type was backed off. */
  backedOffFrom: KnowledgeTriageDecisionType | null;
  /** Whether it was drawn for a person to check. */
  audit: boolean;
}

/** One neighbour, as it was compared. */
interface Neighbour {
  id: string;
  /** As read; acting on the comparison requires it unchanged. */
  content: string;
  similarity: number;
  status: string;
  trust: KnowledgeTrustEnum;
  locked: boolean;
  createdAt: Date;
  relation: PageEntryRelationType | null;
  decidedBy: PageEntryRelationDecider | null;
  preferredId: string | null;
  reason: string | null;
  models: string[];
}

const ENTRY_SELECT = {
  id: true,
  createdAt: true,
  updatedAt: true,
  content: true,
  contentHash: true,
  scope: true,
  kind: true,
  status: true,
  moduleIds: true,
  pageId: true,
  supersedesId: true,
  sourceUserId: true,
  sourceSession: true,
  verifiedAt: true,
  page: {
    select: {
      workspaceId: true,
      workspace: { select: { preferences: true } },
    },
  },
  citations: {
    select: {
      kind: true,
      path: true,
      startLine: true,
      endLine: true,
      snippet: true,
      targetId: true,
      targetLabel: true,
      checkResult: true,
    },
  },
} as const;

type TriagedEntry = Prisma.PageEntryGetPayload<{
  select: typeof ENTRY_SELECT;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Something the decision rested on changed before it could be acted on. The
 * transaction that was acting on it is rolled back, and the decision is
 * recorded as not applied.
 */
class StaleTriage extends Error {}

@Injectable()
export default class KnowledgeTriageService {
  /**
   * The vector service is required, unlike on the write path: a pass that
   * cannot look for the entry's neighbours cannot say it contradicts none of
   * them, so it fails and Bull tries it again rather than deciding blind.
   */
  private readonly logger = new LoggerService('KnowledgeTriageService');

  constructor(
    private prisma: PrismaService,
    private judges: TriageJudges,
    private vector: VectorService,
    @Optional() private indexer?: KnowledgeIndexService,
  ) {}

  /**
   * Triage one entry. Returns null when there is nothing to decide: the entry
   * is gone, no longer waiting for triage, already decided about, or triage
   * is off for its workspace.
   */
  async triage(
    entryId: string,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<TriageOutcome | null> {
    const entry = await this.prisma.pageEntry.findFirst({
      where: { id: entryId, deleted: null, page: { deleted: null } },
      select: ENTRY_SELECT,
    });

    // Only the inbox is triaged. A person who wrote a standing entry was the
    // review, and one that was accepted, disputed or archived since it was
    // written has had its decision made by someone else.
    if (!entry || entry.status !== PageEntryStatus.PROPOSED) {
      return null;
    }

    const workspaceId = entry.page.workspaceId;
    const settings = knowledgeSettings(entry.page.workspace?.preferences, env);

    if (settings.autoTriage === 'off') {
      return null;
    }

    // Once per entry: a retry after the decision was recorded, or a second
    // job for the same entry, changes nothing.
    const decided = await this.prisma.knowledgeTriageDecision.findFirst({
      where: { entryId },
      select: { id: true },
    });

    if (decided) {
      return null;
    }

    const mode =
      settings.autoTriage === 'on'
        ? KnowledgeTriageMode.ON
        : KnowledgeTriageMode.SHADOW;
    const contentHash = entry.contentHash ?? contentHashOf(entry.content);
    const backoff = await backoffState(this.prisma, workspaceId);
    const decide = (found: Found) =>
      this.record(entry, mode, settings.auditRate, heldBack(found, backoff));

    // ------------------------------------------------------------ 1. policy
    // Refused before anything else reads the content, and before any model
    // is sent it: a credential must not travel further than it already has.
    const secret = secretIn(entry.content);
    const severalClaims = secret ? null : severalClaimsIn(entry.content);

    if (secret || severalClaims) {
      return decide({
        decision: KnowledgeTriageDecisionType.REJECT,
        policy: secret
          ? KnowledgeTriagePolicy.SECRET
          : KnowledgeTriagePolicy.ONE_FACT,
        reasons: [],
        // What the policy found, never the content itself.
        inputs: {
          contentHash,
          kind: entry.kind,
          policy: secret
            ? { secret: `it looks like it holds a ${secret}` }
            : { oneFact: severalClaims },
        },
      });
    }

    const reasons = new Set<KnowledgeEscalationReason>();
    const writer = await this.writerOf(entry, workspaceId);
    const cited = await this.citedTexts(entry, workspaceId);

    // Text from outside the workspace, as far as the server can tell: a run
    // its writer was in when it was written, or an issue or comment it
    // cites. Never the session the writer names, which is whatever the
    // client sent. A repeat is held to this too: text known to come from
    // outside should not add weight to what is already there.
    if (writer.externalSource || cited.externalSource) {
      reasons.add(KnowledgeEscalationReason.EXTERNAL_INPUT);
    }

    // Only a person's acceptance retires what a correction replaces: an
    // unreviewed claim must not take accepted knowledge out of use.
    if (entry.supersedesId) {
      reasons.add(KnowledgeEscalationReason.SUPERSEDE_REQUEST);
    }

    // Entries that were there before this one, in its modules, or on its
    // page when it has none: waiting, or served (a consolidated entry is
    // served as its page's evidence). "Before" is a total order, by time and
    // then id, so of two identical entries written at once exactly one
    // corroborates the other.
    const neighbourhood: Prisma.PageEntryWhereInput = {
      id: { not: entry.id },
      deleted: null,
      status: { in: NEIGHBOUR_STATUSES },
      page: { workspaceId, deleted: null },
      ...(entry.moduleIds.length
        ? { moduleIds: { hasSome: entry.moduleIds } }
        : { pageId: entry.pageId }),
      OR: [
        { createdAt: { lt: entry.createdAt } },
        { createdAt: entry.createdAt, id: { lt: entry.id } },
      ],
    };

    // ---------------------------------------------------- 2. exact repeat
    const repeats = await this.prisma.pageEntry.findMany({
      where: { ...neighbourhood, contentHash },
      select: { id: true, status: true, createdAt: true, contentHash: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    // The accepted one if there is one, since that is the one served, and
    // otherwise the first said.
    const repeated =
      repeats.find((row) => isServed(row.status)) ?? repeats[0] ?? null;

    const models: string[] = [];
    const outputs: {
      pairs: Array<{ with: string; judgments: PairJudgment[] }>;
      accept: AcceptJudgment[];
    } = { pairs: [], accept: [] };

    // ------------------------------------------------ 3. near neighbours
    const neighbours = repeated
      ? []
      : await this.nearNeighbours(
          entry,
          neighbourhood,
          settings.similarityThreshold,
        );
    const wouldBe = {
      id: entry.id,
      trust: entryTrust({
        status: PageEntryStatus.STANDING,
        verifiedAt: entry.verifiedAt,
        citations: entry.citations,
      }),
      createdAt: entry.createdAt,
    };

    for (const neighbour of neighbours) {
      const difference = factualDifference(entry.content, neighbour.content);

      // A different number, date, negation or condition is a different
      // fact, whatever a model would make of it.
      if (difference) {
        Object.assign(neighbour, {
          relation: PageEntryRelationType.DISTINCT,
          decidedBy: PageEntryRelationDecider.RULE,
          reason: difference,
        });
        continue;
      }

      if (!this.judges.available()) {
        reasons.add(KnowledgeEscalationReason.NO_LLM);
        continue;
      }

      // The entry passed the credential check; a neighbour written before
      // there was one may not have.
      const judgments = await this.judges.classify(
        entry.content,
        redactSecrets(neighbour.content),
      );
      const asked = judgments
        .map((judgment) => judgment.model)
        .filter((model): model is string => Boolean(model));

      models.push(...asked);
      outputs.pairs.push({ with: neighbour.id, judgments });

      const [first, second] = judgments;
      const agreed =
        first.readable && second.readable && first.type === second.type;

      // Two answers that differ, or one that could not be read, relate
      // nothing: the pair is kept as distinct, and a person settles it.
      if (!agreed) {
        reasons.add(KnowledgeEscalationReason.JUDGES_DISAGREE);
        Object.assign(neighbour, {
          relation: PageEntryRelationType.DISTINCT,
          decidedBy: PageEntryRelationDecider.MODEL,
          models: asked,
          reason:
            first.readable && second.readable
              ? `the judges disagreed: ${first.type.toLowerCase()} and ${second.type.toLowerCase()}`
              : 'a judge gave no answer that could be read',
        });
        continue;
      }

      Object.assign(neighbour, {
        relation: first.type,
        decidedBy: PageEntryRelationDecider.MODEL,
        models: asked,
        reason: first.reason,
      });

      if (
        first.type === PageEntryRelationType.CONTRADICTS ||
        first.type === PageEntryRelationType.SUPERSEDES
      ) {
        // Which of the two stands is precedence's to say, not the model's.
        neighbour.preferredId = preferred(wouldBe, {
          id: neighbour.id,
          trust: neighbour.trust,
          createdAt: neighbour.createdAt,
        }).id;

        if (neighbour.trust === KnowledgeTrustEnum.HUMAN_VERIFIED) {
          reasons.add(KnowledgeEscalationReason.CONTRADICTS_VERIFIED);
        }

        if (neighbour.locked) {
          reasons.add(KnowledgeEscalationReason.CONTRADICTS_LOCKED);
        }
      }
    }

    const nearDuplicate = neighbours.find(
      (neighbour) =>
        neighbour.relation === PageEntryRelationType.DUPLICATE &&
        neighbour.decidedBy === PageEntryRelationDecider.MODEL,
    );
    const corroborates = repeated?.id ?? nearDuplicate?.id ?? null;
    // What the entry it repeats must still be for folding this one in to
    // mean anything: live, and saying the same thing it said when compared.
    const corroboratesAsRead: Prisma.PageEntryWhereInput | null = repeated
      ? { contentHash: repeated.contentHash }
      : nearDuplicate
        ? { content: nearDuplicate.content }
        : null;

    // A repeat is folded into what it repeats rather than accepted, so what
    // acceptance asks of an entry does not apply to it.
    if (!corroborates) {
      // What an agent read cannot be told yet, so "nothing from outside" is
      // a check that could not run. Not a bar to folding a repeat in, which
      // puts no new claim in front of anyone.
      if (writer.unknownSource) {
        reasons.add(KnowledgeEscalationReason.UNKNOWN_SOURCE);
      }

      // ---------------------------------------------------- 4. grounding
      if (entry.citations.length === 0) {
        reasons.add(KnowledgeEscalationReason.UNGROUNDED);
      } else if (
        entry.citations.some(
          (citation) => !HOLDING.has(citation.checkResult ?? ''),
        )
      ) {
        reasons.add(KnowledgeEscalationReason.CITATION_FAILED);
      }

      // A convention is handed to every run in its modules, whether or not
      // it matches the work: accepting one pins it.
      if (entry.kind === PageEntryKind.CONVENTION) {
        reasons.add(KnowledgeEscalationReason.PIN_REQUEST);
      }

      if (
        !entry.scope?.trim() ||
        entry.moduleIds.length > BROAD_SCOPE_MODULES
      ) {
        reasons.add(KnowledgeEscalationReason.BROAD_SCOPE);
      }

      // Precedence can prefer a neighbour over this entry only when a reason
      // above already applies: an entry with no grounding reason is grounded
      // or verified, an unverified neighbour ranks no higher, and between
      // equals the newer, this one, wins. A verified neighbour escalates with
      // CONTRADICTS_VERIFIED. So nothing precedence ruled against is accepted.

      // The last check, and the only one asked of a model about the entry
      // itself; not asked at all when a person has to look anyway.
      if (reasons.size === 0) {
        if (!this.judges.available()) {
          reasons.add(KnowledgeEscalationReason.NO_LLM);
        } else {
          const judgments = await this.judges.accept({
            content: entry.content,
            kind: entry.kind,
            scope: entry.scope,
            evidence: entry.citations.map((citation) =>
              evidenceOf(citation, cited.texts),
            ),
          });

          models.push(
            ...judgments
              .map((judgment) => judgment.model)
              .filter((model): model is string => Boolean(model)),
          );
          outputs.accept = judgments;

          if (!judgments.every((judgment) => judgment.accept)) {
            reasons.add(KnowledgeEscalationReason.JUDGES_DISAGREE);
          }
        }
      }
    }

    // ------------------------------------------------------- 5. decision
    const decision =
      reasons.size > 0
        ? KnowledgeTriageDecisionType.ESCALATE
        : corroborates
          ? KnowledgeTriageDecisionType.CORROBORATE
          : KnowledgeTriageDecisionType.AUTO_ACCEPT;

    const relations = [
      ...(repeated
        ? [
            {
              toId: repeated.id,
              type: PageEntryRelationType.DUPLICATE,
              decidedBy: PageEntryRelationDecider.HASH,
              models: [],
              similarity: null,
              preferredId: null,
              reason: 'the same content',
            },
          ]
        : []),
      ...neighbours
        .filter((neighbour) => neighbour.relation && neighbour.decidedBy)
        .map((neighbour) => ({
          toId: neighbour.id,
          type: neighbour.relation as PageEntryRelationType,
          decidedBy: neighbour.decidedBy as PageEntryRelationDecider,
          models: neighbour.models,
          similarity: neighbour.similarity,
          preferredId: neighbour.preferredId,
          reason: neighbour.reason,
        })),
    ];

    return decide({
      decision,
      policy: null,
      reasons: [...reasons],
      corroborates:
        decision === KnowledgeTriageDecisionType.CORROBORATE
          ? corroborates
          : null,
      corroboratesAsRead,
      // Served entries precedence ruled against, standing or consolidated.
      // Only an accepted entry displaces anything, and only in `on` mode.
      displaces: neighbours.flatMap((neighbour) =>
        neighbour.preferredId === entry.id && isServed(neighbour.status)
          ? [
              {
                id: neighbour.id,
                status: neighbour.status,
                content: neighbour.content,
              },
            ]
          : [],
      ),
      relations,
      models,
      outputs,
      inputs: {
        contentHash,
        kind: entry.kind,
        scope: entry.scope,
        moduleIds: entry.moduleIds,
        pageId: entry.pageId,
        supersedesId: entry.supersedesId,
        citations: entry.citations.map((citation) => ({
          kind: citation.kind,
          result: citation.checkResult,
        })),
        writer,
        cited: cited.targets,
        similarityThreshold: settings.similarityThreshold,
        repeats: repeated?.id ?? null,
        neighbours: neighbours.map((neighbour) => ({
          id: neighbour.id,
          similarity: neighbour.similarity,
          status: neighbour.status,
          trust: neighbour.trust,
          locked: neighbour.locked,
          relation: neighbour.relation,
          decidedBy: neighbour.decidedBy,
          preferredId: neighbour.preferredId,
        })),
      },
    });
  }

  /**
   * The entries most like this one among those it could be related to,
   * nearest first. Asked of the index, then narrowed to the neighbourhood in
   * postgres, which is the authority on status, modules and order.
   */
  private async nearNeighbours(
    entry: TriagedEntry,
    neighbourhood: Prisma.PageEntryWhereInput,
    minSimilarity: number,
  ): Promise<Neighbour[]> {
    const near = await this.vector.findNearEntries(
      entry.page.workspaceId,
      entry.content,
      {
        moduleIds: entry.moduleIds,
        pageId: entry.pageId,
        minSimilarity,
      },
    );
    const similarity = new Map(
      near
        .filter((hit) => hit.entryId !== entry.id)
        .map((hit) => [hit.entryId, hit.similarity]),
    );

    if (similarity.size === 0) {
      return [];
    }

    const rows = await this.prisma.pageEntry.findMany({
      where: { ...neighbourhood, id: { in: [...similarity.keys()] } },
      select: {
        id: true,
        content: true,
        status: true,
        verifiedAt: true,
        createdAt: true,
        page: { select: { entryPolicy: true } },
        citations: { select: { checkResult: true } },
      },
    });

    return rows
      .map((row): Neighbour => ({
        id: row.id,
        content: row.content,
        similarity: similarity.get(row.id) ?? 0,
        status: row.status,
        trust: entryTrust(row),
        locked: row.page.entryPolicy === PageEntryPolicy.LOCKED,
        createdAt: row.createdAt,
        relation: null,
        decidedBy: null,
        preferredId: null,
        reason: null,
        models: [],
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, MAX_NEIGHBOURS);
  }

  /**
   * Who wrote the entry, and what the server can tell about what they read.
   *
   * Nothing that clears an agent. Runs do not write with a credential of
   * their own (ENG-84), so every agent writes through a client that names
   * its own session, and a run of the same agent open at the time may have
   * nothing to do with the entry. Until a run's writes carry the run, every
   * entry not written by a person has an unknown source. The runs are still
   * read, from the server's own record: one on an issue from outside marks
   * the entry, which can only make the decision stricter. A run that has not
   * finished counts whether or not it has started. The session is kept as
   * the writer gave it, for tracing, and trusted for nothing.
   */
  private async writerOf(entry: TriagedEntry, workspaceId: string) {
    const user = entry.sourceUserId
      ? await this.prisma.user.findUnique({
          where: { id: entry.sourceUserId },
          select: { type: true },
        })
      : null;
    // A person answers for what they write and reviews it as they do; the
    // check is on what an agent was handed.
    const person = user?.type === UserType.User;

    const runs =
      entry.sourceUserId && !person
        ? await this.prisma.agentRun.findMany({
            where: {
              workspaceId,
              agentUserId: entry.sourceUserId,
              deleted: null,
              createdAt: { lte: entry.createdAt },
              OR: [
                { finishedAt: null },
                { finishedAt: { gte: entry.createdAt } },
              ],
            },
            select: {
              id: true,
              modelId: true,
              issue: {
                select: {
                  id: true,
                  sourceMetadata: true,
                  support: { select: { id: true } },
                  team: { select: { preferences: true } },
                  linkedIssue: {
                    where: { deleted: null },
                    select: { sourceData: true, sync: true },
                  },
                  // Every comment there was to read when the entry was
                  // written, including one deleted since.
                  comments: {
                    where: { createdAt: { lte: entry.createdAt } },
                    select: { sourceMetadata: true },
                  },
                },
              },
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          })
        : [];

    const read = runs.map((run) => ({
      id: run.id,
      model: run.modelId,
      issueId: run.issue.id,
      externalSource: externalSourceOf(run.issue),
    }));

    return {
      userId: entry.sourceUserId,
      userType: user?.type ?? null,
      session: entry.sourceSession,
      runs: read,
      externalSource:
        read.find((run) => run.externalSource)?.externalSource ?? null,
      unknownSource: !person,
    };
  }

  /**
   * The text of the issues and comments the entry cites, as the acceptance
   * judges are shown it, and whether any of it came from outside the
   * workspace. A citation that holds says only that its target exists; what
   * the target says is what grounds the claim.
   */
  private async citedTexts(entry: TriagedEntry, workspaceId: string) {
    const idsOf = (kind: PageEntryCitationKind) =>
      entry.citations
        .filter(
          (citation) =>
            citation.kind === kind &&
            citation.targetId &&
            UUID.test(citation.targetId),
        )
        .map((citation) => citation.targetId as string);
    const issueIds = idsOf(PageEntryCitationKind.ISSUE);
    const commentIds = idsOf(PageEntryCitationKind.COMMENT);

    const [issues, comments] = await Promise.all([
      issueIds.length
        ? this.prisma.issue.findMany({
            where: {
              id: { in: issueIds },
              deleted: null,
              team: { workspaceId, deleted: null },
            },
            select: {
              id: true,
              title: true,
              description: true,
              sourceMetadata: true,
              support: { select: { id: true } },
              team: { select: { preferences: true } },
              linkedIssue: {
                where: { deleted: null },
                select: { sourceData: true, sync: true },
              },
              // Its thread is part of what the entry could rest on, though
              // only the description is shown to the judges.
              comments: {
                where: { createdAt: { lte: entry.createdAt } },
                select: { sourceMetadata: true },
              },
            },
          })
        : [],
      commentIds.length
        ? this.prisma.issueComment.findMany({
            where: {
              id: { in: commentIds },
              deleted: null,
              issue: { deleted: null, team: { workspaceId, deleted: null } },
            },
            select: { id: true, body: true, sourceMetadata: true },
          })
        : [],
    ]);

    // Plain text rather than markdown: markdown escapes the underscores in a
    // token, and an escaped credential no longer looks like one.
    const texts = new Map<string, string>();
    const targets: Array<{
      kind: PageEntryCitationKind;
      id: string;
      externalSource: string | null;
    }> = [];

    for (const issue of issues) {
      texts.set(
        issue.id,
        citedText(
          `${issue.title}\n\n${convertTiptapJsonToText(
            issue.description ?? '',
          )}`,
        ),
      );
      targets.push({
        kind: PageEntryCitationKind.ISSUE,
        id: issue.id,
        externalSource: externalSourceOf(issue),
      });
    }

    for (const comment of comments) {
      texts.set(comment.id, citedText(convertTiptapJsonToText(comment.body)));
      targets.push({
        kind: PageEntryCitationKind.COMMENT,
        id: comment.id,
        externalSource: commentSourceOf(comment),
      });
    }

    return {
      texts,
      targets,
      externalSource:
        targets.find((target) => target.externalSource)?.externalSource ?? null,
    };
  }

  /**
   * Writes the decision with the relations found and, in `on` mode, acts on
   * it, all in one transaction: a decision is never recorded as applied
   * without its effect, nor an effect left without its decision.
   *
   * Acting is conditional on everything it acts on being as it was read: the
   * entry, the entry it repeats, and each entry it displaces. If any of them
   * was edited, triaged or verified by a person, or deleted while the pass
   * ran, nothing is changed, and the decision is recorded as not applied,
   * with why. A decision that was acted on is drawn for audit at
   * `auditRate`, by its id, so the draw can be worked out again.
   */
  private async record(
    entry: TriagedEntry,
    mode: KnowledgeTriageMode,
    auditRate: number,
    found: Found,
  ): Promise<TriageOutcome> {
    const changed: string[] = [];
    // Chosen here so the audit draw can be seeded with it.
    const id = randomUUID();

    const write = (act: boolean, notApplied?: string) =>
      this.prisma.$transaction(async (tx) => {
        for (const relation of found.relations ?? []) {
          const data = {
            type: relation.type,
            decidedBy: relation.decidedBy,
            models: relation.models,
            similarity: relation.similarity,
            preferredId: relation.preferredId,
            reason: relation.reason,
          };

          await tx.pageEntryRelation.upsert({
            where: { fromId_toId: { fromId: entry.id, toId: relation.toId } },
            create: { fromId: entry.id, toId: relation.toId, ...data },
            update: data,
          });
        }

        const applied = act
          ? await this.apply(tx, entry, found, changed)
          : false;
        // Drawn from what was acted on without a person: whatever else was
        // decided reaches a person anyway. Never a refused credential, which
        // an audit would only put in front of more people.
        const drawn = applied && found.policy !== KnowledgeTriagePolicy.SECRET;
        const audit = drawn && auditDraw(id) < auditRate;
        const outputs =
          notApplied !== undefined
            ? { ...found.outputs, notApplied }
            : found.outputs;

        const decision = await tx.knowledgeTriageDecision.create({
          data: {
            id,
            entryId: entry.id,
            workspaceId: entry.page.workspaceId,
            decision: found.decision,
            reasons: found.reasons,
            policy: found.policy,
            mode,
            applied,
            corroboratedEntryId: found.corroborates ?? null,
            backedOffFrom: found.backedOffFrom ?? null,
            audit,
            auditRate: drawn ? auditRate : null,
            inputs: found.inputs as Prisma.InputJsonValue,
            inputsDigest: digestOf(found.inputs),
            models: found.models ?? [],
            ...(outputs !== undefined && {
              outputs: outputs as Prisma.InputJsonValue,
            }),
          },
          select: { id: true },
        });

        return { id: decision.id, applied, audit };
      });

    let result: { id: string; applied: boolean; audit: boolean };

    try {
      result = await write(mode === KnowledgeTriageMode.ON);
    } catch (error) {
      if (!(error instanceof StaleTriage)) {
        throw error;
      }

      // Rolled back: record what was decided, and that it was not acted on.
      changed.length = 0;
      result = await write(false, error.message);
    }

    if (changed.length) {
      await this.indexer?.entriesChanged(changed);
    }

    if (
      result.applied &&
      found.decision === KnowledgeTriageDecisionType.AUTO_ACCEPT
    ) {
      await this.answerGapsQuietly(entry.id);
    }

    return {
      decisionId: result.id,
      decision: found.decision,
      reasons: found.reasons,
      policy: found.policy,
      mode,
      applied: result.applied,
      backedOffFrom: found.backedOffFrom ?? null,
      audit: result.audit,
    };
  }

  /**
   * Marks answered the knowledge gaps an entry triage accepted answers, by
   * citing the issue opened for them. After the decision is written, and best
   * effort, as when a person accepts one: the gap job marks any this misses.
   */
  private async answerGapsQuietly(entryId: string): Promise<void> {
    try {
      await answerGaps(this.prisma, [entryId]);
    } catch (error) {
      this.logger.warn({
        message: `Could not mark the knowledge gaps entry ${entryId} answers: ${error}; the gap job will`,
        where: 'KnowledgeTriageService.answerGapsQuietly',
      });
    }
  }

  /**
   * Acts on a decision in `on` mode. False when there is nothing to act on;
   * throws `StaleTriage` when something it would act on changed since it was
   * read, which rolls back whatever it had already changed.
   */
  private async apply(
    tx: Prisma.TransactionClient,
    entry: TriagedEntry,
    found: Found,
    changed: string[],
  ): Promise<boolean> {
    // An escalation waits for a person, whatever the mode.
    if (found.decision === KnowledgeTriageDecisionType.ESCALATE) {
      return false;
    }

    const status =
      found.decision === KnowledgeTriageDecisionType.AUTO_ACCEPT
        ? PageEntryStatus.STANDING
        : PageEntryStatus.ARCHIVED;

    const { count } = await tx.pageEntry.updateMany({
      where: {
        id: entry.id,
        deleted: null,
        status: PageEntryStatus.PROPOSED,
        updatedAt: entry.updatedAt,
      },
      data: { status },
    });

    if (count === 0) {
      throw new StaleTriage('the entry changed while it was triaged');
    }

    changed.push(entry.id);

    if (found.corroborates) {
      const { count: corroborated } = await tx.pageEntry.updateMany({
        where: {
          id: found.corroborates,
          deleted: null,
          status: { in: NEIGHBOUR_STATUSES },
          page: { deleted: null },
          ...found.corroboratesAsRead,
        },
        data: { corroborationCount: { increment: 1 } },
      });

      // Archiving a repeat of something no longer there, or no longer
      // saying the same, would lose the only copy of the claim.
      if (corroborated === 0) {
        throw new StaleTriage(
          `the entry it repeats, ${found.corroborates}, changed while it was triaged`,
        );
      }
    }

    // Disputed rather than superseded: withheld until a person looks, and
    // reversible, because a model found the contradiction. Each only as it
    // was compared: a person verifying it, rewording it or locking its page
    // since takes it out of what precedence decided about.
    if (found.decision === KnowledgeTriageDecisionType.AUTO_ACCEPT) {
      for (const displaced of found.displaces ?? []) {
        const { count: disputed } = await tx.pageEntry.updateMany({
          where: {
            id: displaced.id,
            deleted: null,
            status: displaced.status,
            verifiedAt: null,
            content: displaced.content,
            page: {
              deleted: null,
              entryPolicy: { not: PageEntryPolicy.LOCKED },
            },
          },
          data: { status: PageEntryStatus.DISPUTED },
        });

        if (disputed === 0) {
          throw new StaleTriage(
            `the entry it contradicts, ${displaced.id}, changed while it was triaged`,
          );
        }

        changed.push(displaced.id);
      }
    }

    return true;
  }
}

/** What a pass found, as it is recorded and acted on. */
interface Found {
  decision: KnowledgeTriageDecisionType;
  policy: KnowledgeTriagePolicy | null;
  reasons: KnowledgeEscalationReason[];
  inputs: Record<string, unknown>;
  corroborates?: string | null;
  /** What the entry it repeats must still match to be corroborated. */
  corroboratesAsRead?: Prisma.PageEntryWhereInput | null;
  /** Standing entries precedence ruled against, with their content as read. */
  displaces?: Array<{ id: string; status: PageEntryStatus; content: string }>;
  relations?: Array<{
    toId: string;
    type: PageEntryRelationType;
    decidedBy: PageEntryRelationDecider;
    models: string[];
    similarity: number | null;
    preferredId: string | null;
    reason: string | null;
  }>;
  models?: string[];
  outputs?: Record<string, unknown>;
  /** The decision it reached, when its type was backed off. */
  backedOffFrom?: KnowledgeTriageDecisionType | null;
}

/**
 * What a pass decides once back-off has had its say: a decision of a type
 * people have lately disagreed with escalates instead, with what it would
 * have been kept beside it. Never a refused credential, which no measure of
 * agreement lets through.
 */
function heldBack(found: Found, backoff: Map<string, BackoffState>): Found {
  if (
    !isActing(found.decision) ||
    found.policy === KnowledgeTriagePolicy.SECRET ||
    !backoff.get(found.decision)?.backedOff
  ) {
    return found;
  }

  return {
    ...found,
    decision: KnowledgeTriageDecisionType.ESCALATE,
    reasons: [KnowledgeEscalationReason.LOW_AGREEMENT],
    backedOffFrom: found.decision,
    corroborates: null,
  };
}

/**
 * A citation as the acceptance judges are shown it: the lines as the server
 * read them, or the issue or comment as it reads now. Any credential in them
 * is withheld; the entry passed that check, what it cites did not have to.
 */
function evidenceOf(
  citation: TriagedEntry['citations'][number],
  texts: Map<string, string>,
): string {
  const result = (citation.checkResult ?? 'unchecked').toLowerCase();

  if (citation.kind === PageEntryCitationKind.CODE) {
    const lines =
      citation.startLine && citation.endLine
        ? `:${citation.startLine}-${citation.endLine}`
        : '';

    return `${citation.path ?? '(no path)'}${lines} (${result})\n${
      citation.snippet === null ? '(not read)' : redactSecrets(citation.snippet)
    }`;
  }

  const label = `${citation.kind.toLowerCase().replace('_', ' ')} ${
    citation.targetLabel ?? '(unknown)'
  } (${result})`;
  const text = citation.targetId ? texts.get(citation.targetId) : undefined;

  return text === undefined
    ? `${label}; its text is not shown`
    : `${label}\n${text}`;
}

/**
 * A cited issue's or comment's text, cut to what the judges are shown.
 * Redacted before it is cut, so a cut cannot hide a credential's shape.
 */
function citedText(text: string): string {
  const redacted = redactSecrets(text.trim());

  return redacted.length > MAX_CITED_TEXT
    ? `${redacted.slice(0, MAX_CITED_TEXT)} [cut]`
    : redacted;
}

/** A digest of what a decision was made on, stable for the same inputs. */
export function digestOf(inputs: unknown): string {
  return createHash('sha256').update(stableJson(inputs)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }

  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson(
            (value as Record<string, unknown>)[key],
          )}`,
      )
      .join(',')}}`;
  }

  return JSON.stringify(value ?? null);
}
