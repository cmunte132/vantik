import { createHash } from 'node:crypto';

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
} from '@prisma/client';
import { KnowledgeTrustEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { VectorService } from 'modules/vector/vector.service';

import KnowledgeIndexService from '../knowledge-index.service';
import { entryTrust } from '../knowledge-proof';
import { knowledgeSettings } from '../knowledge-settings';
import { contentHashOf } from '../page-entries.service';
import { preferred } from './precedence';
import { factualDifference } from './relation-guard';
import TriageJudges, {
  type AcceptJudgment,
  type PairJudgment,
} from './triage-judges';
import { externalSourceOf, secretIn, severalClaimsIn } from './triage-policy';

/**
 * Decides what becomes of a new entry before a person looks at it.
 *
 * One pass per entry, in a fixed order, cheapest and most certain first:
 *
 * 1. policy: a credential or several claims in one entry is refused outright,
 *    and an entry from a run that read text from outside the workspace is
 *    marked for a person, before any model sees it;
 * 2. an exact repeat, found by hash, corroborates the entry it repeats;
 * 3. the nearest entries in the same modules are related to it, by a rule in
 *    code where the two differ in a number, date, negation or condition, and
 *    otherwise by two model judgments that must agree;
 * 4. grounding: every citation must hold, and an entry that cites nothing is
 *    not grounded;
 * 5. the decision, and in `on` mode, acting on it.
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
 * More modules than one fact is about. A scope that reaches this many is a
 * claim about most of a codebase, which every run in each of them would be
 * handed; a person decides whether it is true that widely.
 */
export const BROAD_SCOPE_MODULES = 3;

/** Results under which a citation still supports its claim. */
const HOLDING = new Set<string>(['HOLDS', 'MOVED']);

/** What a triage pass decided, as its caller logs it. */
export interface TriageOutcome {
  decisionId: string;
  decision: KnowledgeTriageDecisionType;
  reasons: KnowledgeEscalationReason[];
  policy: KnowledgeTriagePolicy | null;
  mode: KnowledgeTriageMode;
  applied: boolean;
}

/** One neighbour, as it was compared. */
interface Neighbour {
  id: string;
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
      targetLabel: true,
      checkResult: true,
    },
  },
} as const;

type TriagedEntry = Prisma.PageEntryGetPayload<{
  select: typeof ENTRY_SELECT;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export default class KnowledgeTriageService {
  /**
   * The vector service is required, unlike on the write path: a pass that
   * cannot look for the entry's neighbours cannot say it contradicts none of
   * them, so it fails and Bull tries it again rather than deciding blind.
   */
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

    // ------------------------------------------------------------ 1. policy
    // Refused before anything else reads the content, and before any model
    // is sent it: a credential must not travel further than it already has.
    const secret = secretIn(entry.content);
    const severalClaims = secret ? null : severalClaimsIn(entry.content);

    if (secret || severalClaims) {
      return this.record(entry, mode, {
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

    if (writer.externalSource) {
      reasons.add(KnowledgeEscalationReason.EXTERNAL_INPUT);
    }

    // Only a person's acceptance retires what a correction replaces: an
    // unreviewed claim must not take accepted knowledge out of use.
    if (entry.supersedesId) {
      reasons.add(KnowledgeEscalationReason.SUPERSEDE_REQUEST);
    }

    // Entries that were there before this one, in its modules, or on its
    // page when it has none. "Before" is a total order, by time and then id,
    // so of two identical entries written at once exactly one corroborates
    // the other.
    const neighbourhood: Prisma.PageEntryWhereInput = {
      id: { not: entry.id },
      deleted: null,
      status: {
        in: [PageEntryStatus.PROPOSED, PageEntryStatus.STANDING],
      },
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
      select: { id: true, status: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    // The accepted one if there is one, since that is the one served, and
    // otherwise the first said.
    const repeated =
      repeats.find((row) => row.status === PageEntryStatus.STANDING) ??
      repeats[0] ??
      null;

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

      const judgments = await this.judges.classify(
        entry.content,
        neighbour.content,
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

    // A repeat is folded into what it repeats rather than accepted, so what
    // acceptance asks of an entry does not apply to it.
    if (!corroborates) {
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

      if (entry.moduleIds.length > BROAD_SCOPE_MODULES) {
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
            evidence: entry.citations.map(evidenceOf),
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

    return this.record(entry, mode, {
      decision,
      policy: null,
      reasons: [...reasons],
      corroborates:
        decision === KnowledgeTriageDecisionType.CORROBORATE
          ? corroborates
          : null,
      // Standing entries precedence ruled against. Only an accepted entry
      // displaces anything, and only in `on` mode.
      displaces: neighbours
        .filter(
          (neighbour) =>
            neighbour.preferredId === entry.id &&
            neighbour.status === PageEntryStatus.STANDING,
        )
        .map((neighbour) => neighbour.id),
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
  ): Promise<Array<Neighbour & { content: string }>> {
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
      .map((row): Neighbour & { content: string } => ({
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
   * Who wrote the entry, and whether the run that wrote it read text from
   * outside the workspace. A hosted run writes with its run id as the
   * session, and the run names its issue.
   */
  private async writerOf(entry: TriagedEntry, workspaceId: string) {
    const run =
      entry.sourceSession && UUID.test(entry.sourceSession)
        ? await this.prisma.agentRun.findFirst({
            where: { id: entry.sourceSession, workspaceId },
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
                },
              },
            },
          })
        : null;

    return {
      userId: entry.sourceUserId,
      session: entry.sourceSession,
      runId: run?.id ?? null,
      model: run?.modelId ?? null,
      issueId: run?.issue?.id ?? null,
      externalSource: run?.issue ? externalSourceOf(run.issue) : null,
    };
  }

  /**
   * Writes the decision with the relations found and, in `on` mode, acts on
   * it, all in one transaction: a decision is never recorded as applied
   * without its effect, nor an effect left without its decision.
   *
   * Acting is conditional on the entry being exactly as it was read. An entry
   * edited, triaged by a person, or deleted while the pass ran is left alone,
   * and the decision records that it was not applied.
   */
  private async record(
    entry: TriagedEntry,
    mode: KnowledgeTriageMode,
    found: {
      decision: KnowledgeTriageDecisionType;
      policy: KnowledgeTriagePolicy | null;
      reasons: KnowledgeEscalationReason[];
      inputs: Record<string, unknown>;
      corroborates?: string | null;
      displaces?: string[];
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
      outputs?: unknown;
    },
  ): Promise<TriageOutcome> {
    const changed: string[] = [];

    const { id, applied } = await this.prisma.$transaction(async (tx) => {
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

      const applied =
        mode === KnowledgeTriageMode.ON
          ? await this.apply(tx, entry, found, changed)
          : false;

      const decision = await tx.knowledgeTriageDecision.create({
        data: {
          entryId: entry.id,
          workspaceId: entry.page.workspaceId,
          decision: found.decision,
          reasons: found.reasons,
          policy: found.policy,
          mode,
          applied,
          corroboratedEntryId: found.corroborates ?? null,
          inputs: found.inputs as Prisma.InputJsonValue,
          inputsDigest: digestOf(found.inputs),
          models: found.models ?? [],
          ...(found.outputs !== undefined && {
            outputs: found.outputs as Prisma.InputJsonValue,
          }),
        },
        select: { id: true },
      });

      return { id: decision.id, applied };
    });

    if (changed.length) {
      await this.indexer?.entriesChanged(changed);
    }

    return {
      decisionId: id,
      decision: found.decision,
      reasons: found.reasons,
      policy: found.policy,
      mode,
      applied,
    };
  }

  /** Acts on a decision in `on` mode. True when anything changed. */
  private async apply(
    tx: Prisma.TransactionClient,
    entry: TriagedEntry,
    found: {
      decision: KnowledgeTriageDecisionType;
      corroborates?: string | null;
      displaces?: string[];
    },
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
      return false;
    }

    changed.push(entry.id);

    if (found.corroborates) {
      await tx.pageEntry.updateMany({
        where: { id: found.corroborates, deleted: null },
        data: { corroborationCount: { increment: 1 } },
      });
    }

    // Disputed rather than superseded: withheld until a person looks, and
    // reversible, because a model found the contradiction.
    if (
      found.decision === KnowledgeTriageDecisionType.AUTO_ACCEPT &&
      found.displaces?.length
    ) {
      await tx.pageEntry.updateMany({
        where: {
          id: { in: found.displaces },
          deleted: null,
          status: PageEntryStatus.STANDING,
        },
        data: { status: PageEntryStatus.DISPUTED },
      });
      changed.push(...found.displaces);
    }

    return true;
  }
}

/** A citation as the acceptance judges are shown it. */
function evidenceOf(citation: TriagedEntry['citations'][number]): string {
  if (citation.kind === PageEntryCitationKind.CODE) {
    const lines =
      citation.startLine && citation.endLine
        ? `:${citation.startLine}-${citation.endLine}`
        : '';

    return `${citation.path ?? '(no path)'}${lines} (${(
      citation.checkResult ?? 'unchecked'
    ).toLowerCase()})\n${citation.snippet ?? '(not read)'}`;
  }

  return `${citation.kind.toLowerCase().replace('_', ' ')} ${
    citation.targetLabel ?? '(unknown)'
  } (${(citation.checkResult ?? 'unchecked').toLowerCase()})`;
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
