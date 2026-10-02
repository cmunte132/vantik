import { createHash, randomUUID } from 'node:crypto';

import { InjectQueue } from '@nestjs/bull';
import { Injectable, Optional } from '@nestjs/common';
import {
  KnowledgeEscalationReason,
  KnowledgeTriageDecisionType,
  KnowledgeTriageMode,
  KnowledgeTriagePolicy,
  KnowledgeTriageTrigger,
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
import { Queue } from 'bull';
import { PrismaService } from 'nestjs-prisma';

import {
  liveEntryIn,
  onLivePageOrLoose,
  onUnlockedPageOrLoose,
} from 'common/page-entry-where';
import { convertTiptapJsonToText } from 'common/utils/tiptap.utils';

import { LoggerService } from 'modules/logger/logger.service';
import { VectorService } from 'modules/vector/vector.service';

import { entryTrust } from '../knowledge-proof';
import { knowledgeSettings } from '../knowledge-settings';
import { contentHashOf } from '../page-entries.service';
import {
  PAGES_QUEUE,
  retriageJobOptions,
  TRIAGE_ENTRY_JOB,
  VERIFY_ENTRY_JOB,
  verifyEntryJobOptions,
} from '../pages.interface';
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
 * 4. acceptance: every citation must hold, and an entry that cites nothing
 *    is not grounded. Evidence decides, not the writer: an agent's grounded
 *    entry is accepted as a person's is, and only an ungrounded one is held
 *    against its unknown source (see `writerOf`);
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
 *
 * A pass runs when the entry is written. While the entry waits for a person
 * after an escalation, a pass runs again each time its evidence changes: a
 * citation that the server could not read is read, a change to the code
 * touches a cited file, or a newer entry that says the same is accepted.
 * Each decision records its trigger, and the latest decision is the one that
 * counts.
 *
 * An entry escalated because it cites nothing that can be checked goes to
 * the verifier agent first (see `KnowledgeVerifierService`), once. A person
 * does not see it while the verifier looks. What the verifier finds is
 * attached, and triage decides again.
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

/**
 * Citations whose text the acceptance judges are shown. A run or a pull
 * request holds while it exists, which says nothing about the claim.
 *
 * An outside page is evidence of the same sort as code: the server read it,
 * and found the quote on it. It is not EXTERNAL_INPUT. That reason is about
 * where the entry's own text came from, and a page that the server reads is
 * data that the judges assess, as the lines of a file are.
 */
const READABLE: PageEntryCitationKind[] = [
  PageEntryCitationKind.CODE,
  PageEntryCitationKind.ISSUE,
  PageEntryCitationKind.COMMENT,
  PageEntryCitationKind.URL,
];

/**
 * Whether evidence can confirm an entry: every citation still holds, and at
 * least one of them shows the judges what it says.
 */
function isGrounded(
  citations: Array<{ kind: PageEntryCitationKind; checkResult: string | null }>,
) {
  return (
    citations.some((citation) => READABLE.includes(citation.kind)) &&
    citations.every((citation) => HOLDING.has(citation.checkResult ?? ''))
  );
}

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

/** Whether a neighbour was found to say otherwise than the entry. */
function opposes(neighbour: Neighbour) {
  return (
    neighbour.relation === PageEntryRelationType.CONTRADICTS ||
    neighbour.relation === PageEntryRelationType.SUPERSEDES
  );
}

/** Whether any reason makes the entry a person's to decide. */
function hasHard(reasons: Set<KnowledgeEscalationReason>) {
  return [...reasons].some((reason) => !SOFT_REASONS.has(reason));
}

/** What a triage pass decided, as its caller logs it. */
export interface TriageOutcome {
  decisionId: string;
  /** What made triage decide. */
  trigger: KnowledgeTriageTrigger;
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

/**
 * The version of the rules triage decides by. Raised when they change what
 * becomes of an entry, so that an entry still waiting under the old rules is
 * decided again (see `triage` and `sweep`). 2: the provisional tier.
 */
export const TRIAGE_POLICY_VERSION = 2;

/**
 * Corroborations by other entries that promote a provisional entry: as many
 * separate writes saying the same thing as this settle it without evidence.
 */
export const PROVISIONAL_PROMOTE_CORROBORATIONS = 2;

/**
 * What keeps an entry from being accepted without making it a person's to
 * decide. Each says only that nothing confirms the entry: it cites nothing,
 * what it cites no longer holds or does not settle it, its writer is not
 * known, or it would reach further than an unconfirmed claim should. An
 * entry with only these reasons is put in use as provisional, served as
 * unverified, and settled later by evidence or use. Every other reason
 * (something it contradicts that a person answers for, text from outside,
 * a correction, no model, back-off, an audit) waits for a person.
 */
export const SOFT_REASONS: ReadonlySet<KnowledgeEscalationReason> = new Set([
  KnowledgeEscalationReason.UNGROUNDED,
  KnowledgeEscalationReason.CITATION_FAILED,
  KnowledgeEscalationReason.UNKNOWN_SOURCE,
  KnowledgeEscalationReason.JUDGES_DISAGREE,
  KnowledgeEscalationReason.PIN_REQUEST,
  KnowledgeEscalationReason.BROAD_SCOPE,
]);

/** An entry that waits for triage or a person. */
function isWaiting(entry: { status: string }) {
  return entry.status === PageEntryStatus.PROPOSED;
}

/** An entry triage put in use as provisional, and nothing has settled since. */
function isProvisional(entry: {
  status: string;
  provisionalSince: Date | null;
}) {
  return entry.status === PageEntryStatus.STANDING && !!entry.provisionalSince;
}

/** How old an entry must be before the nightly sweep queues triage for it. */
export const TRIAGE_SWEEP_AFTER_MS = 60 * 60 * 1000;

/** The most entries of each kind one nightly sweep queues triage for. */
export const TRIAGE_SWEEP_LIMIT = 50;

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
  provisionalSince: true,
  workspaceId: true,
  workspace: { select: { preferences: true } },
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
      checkedAt: true,
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
    @Optional() @InjectQueue(PAGES_QUEUE) private pagesQueue?: Queue,
  ) {}

  /**
   * Triage one entry. Returns null when there is nothing to decide: the entry
   * is gone, no longer waiting for triage, or triage is off for its
   * workspace. A pass for a new entry (`WRITTEN`) also returns null when the
   * entry has a decision. Any other trigger decides again only about an entry
   * that waits after an escalation or is in use as provisional, and only when
   * the evidence differs from what the last decision saw.
   *
   * A decision that binds nothing is set aside, whatever the trigger: one
   * made in shadow, once triage is on, and one made under an earlier
   * `TRIAGE_POLICY_VERSION` about an entry that still waits.
   */
  async triage(
    entryId: string,
    env: NodeJS.ProcessEnv = process.env,
    trigger: KnowledgeTriageTrigger = KnowledgeTriageTrigger.WRITTEN,
  ): Promise<TriageOutcome | null> {
    const entry = await this.prisma.pageEntry.findFirst({
      where: { id: entryId, deleted: null, ...onLivePageOrLoose() },
      select: ENTRY_SELECT,
    });

    // Only the inbox, and what triage put in use as provisional, is triaged.
    // A person who wrote a standing entry was the review, and one that was
    // accepted, disputed or archived since it was written has had its
    // decision made by someone else.
    if (!entry || !(isWaiting(entry) || isProvisional(entry))) {
      return null;
    }

    const workspaceId = entry.workspaceId;
    const settings = knowledgeSettings(entry.workspace?.preferences, env);

    if (settings.autoTriage === 'off') {
      return null;
    }

    const servedDuplicates = await this.servedDuplicatesOf(entry, workspaceId);
    const evidenceDigest = digestOf(evidenceOfEntry(entry, servedDuplicates));

    // Once for each state of the evidence. A retry after the decision was
    // recorded, or a second job for the same entry, changes nothing. A later
    // pass decides again only about an entry that waits for a person or is
    // provisional, and only when what it rests on changed since the last
    // decision.
    const last = await this.prisma.knowledgeTriageDecision.findFirst({
      where: { entryId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { decision: true, applied: true, inputs: true, mode: true },
    });
    const lastInputs = last?.inputs as {
      evidenceDigest?: string;
      policyVersion?: number;
    } | null;
    // A decision made in shadow never acted, and one made under an earlier
    // policy was made by rules that no longer apply.
    const setAside =
      isWaiting(entry) &&
      ((last?.mode === KnowledgeTriageMode.SHADOW &&
        settings.autoTriage === 'on') ||
        (lastInputs?.policyVersion ?? 1) !== TRIAGE_POLICY_VERSION);
    const open =
      (last?.decision === KnowledgeTriageDecisionType.ESCALATE &&
        !last.applied) ||
      last?.decision === KnowledgeTriageDecisionType.PROVISIONAL;

    if (
      last &&
      !setAside &&
      (trigger === KnowledgeTriageTrigger.WRITTEN ||
        !open ||
        lastInputs?.evidenceDigest === evidenceDigest)
    ) {
      return null;
    }

    const mode =
      settings.autoTriage === 'on'
        ? KnowledgeTriageMode.ON
        : KnowledgeTriageMode.SHADOW;
    const contentHash = entry.contentHash ?? contentHashOf(entry.content);
    const backoff = await backoffState(this.prisma, workspaceId);
    const decide = (found: Found) =>
      this.record(
        entry,
        mode,
        trigger,
        settings.auditRate,
        heldBack(
          {
            ...found,
            inputs: {
              ...found.inputs,
              trigger,
              evidenceDigest,
              policyVersion: TRIAGE_POLICY_VERSION,
            },
          },
          backoff,
        ),
      );

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

    // A correction retires what it replaces. It needs a person when what it
    // replaces is what a person answers for (verified, or on a page kept by
    // hand), and when that is itself an undecided correction, whose chain
    // only a person's acceptance walks. Otherwise it is held to what any
    // entry is held to, and accepting it retires its target (see `apply`).
    const supersedes = entry.supersedesId
      ? await this.prisma.pageEntry.findFirst({
          where: { id: entry.supersedesId, deleted: null },
          select: {
            id: true,
            status: true,
            content: true,
            verifiedAt: true,
            page: { select: { entryPolicy: true } },
          },
        })
      : null;

    if (entry.supersedesId) {
      if (!supersedes || !isServed(supersedes.status)) {
        reasons.add(KnowledgeEscalationReason.SUPERSEDE_REQUEST);
      } else if (supersedes.verifiedAt) {
        reasons.add(KnowledgeEscalationReason.CONTRADICTS_VERIFIED);
      } else if (supersedes.page?.entryPolicy === PageEntryPolicy.LOCKED) {
        reasons.add(KnowledgeEscalationReason.CONTRADICTS_LOCKED);
      }
    }

    // Entries that were there before this one, in its modules, or on its
    // page when it has none: waiting, or served (a consolidated entry is
    // served as its page's evidence). A loose entry with no modules has no
    // page either, so its neighbours are the loose entries of its scope.
    // "Before" is a total order, by time and then id, so of two identical
    // entries written at once exactly one corroborates the other.
    const neighbourhood: Prisma.PageEntryWhereInput = {
      id: { not: entry.id },
      deleted: null,
      status: { in: NEIGHBOUR_STATUSES },
      ...liveEntryIn(workspaceId),
      ...(entry.moduleIds.length
        ? { moduleIds: { hasSome: entry.moduleIds } }
        : entry.pageId
          ? { pageId: entry.pageId }
          : { pageId: null, scope: entry.scope }),
      OR: [
        { createdAt: { lt: entry.createdAt } },
        { createdAt: entry.createdAt, id: { lt: entry.id } },
      ],
    };

    // Evidence settles a claim, whoever wrote it (see step 4). A grounded
    // entry is not folded into a waiting one that says the same: the fold
    // would archive the evidence and leave the claim with a person. It is
    // decided on its own, and once it is accepted the waiting one is
    // triaged again and folds into it.
    //
    // Nor is it folded into a provisional entry: folding it in would leave
    // the claim served as unverified, without the evidence that verifies it.
    // It is accepted, and replaces the provisional one (see `displaces`).
    const grounded = isGrounded(entry.citations);
    const canFoldInto = (row: { status: string; provisional: boolean }) =>
      isServed(row.status) ? !(grounded && row.provisional) : !grounded;

    // ---------------------------------------------------- 2. exact repeat
    const repeats = await this.prisma.pageEntry.findMany({
      where: { ...neighbourhood, contentHash },
      select: {
        id: true,
        status: true,
        content: true,
        createdAt: true,
        contentHash: true,
        provisionalSince: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const asFolded = (row: (typeof repeats)[number]) => ({
      status: row.status,
      provisional: isProvisional(row),
    });
    // The accepted one if there is one, since that is the one served, and
    // otherwise the first said.
    const repeatOf =
      repeats.find((row) => isServed(row.status)) ?? repeats[0] ?? null;
    const repeated =
      repeatOf && canFoldInto(asFolded(repeatOf)) ? repeatOf : null;
    // A served entry written after this one that triage found says the same
    // thing. It is the one served, so this one folds into it.
    const foldsInto =
      servedDuplicates.find((row) =>
        canFoldInto({ status: row.status, provisional: isProvisional(row) }),
      ) ?? null;

    const models: string[] = [];
    const outputs: {
      pairs: Array<{ with: string; judgments: PairJudgment[] }>;
      accept: AcceptJudgment[];
    } = { pairs: [], accept: [] };

    // ------------------------------------------------ 3. near neighbours
    const neighbours =
      repeated || foldsInto
        ? []
        : await this.nearNeighbours(
            entry,
            {
              ...neighbourhood,
              id: { notIn: [entry.id, ...repeats.map((row) => row.id)] },
            },
            settings.similarityThreshold,
          );
    // Set when a disagreement is a person's to settle: about how the entry
    // relates to something a person answers for, as an agreed contradiction
    // would be, or about whether its evidence contradicts it.
    let needsPerson = false;

    for (const neighbour of neighbours) {
      // A different number, date, negation or condition prevents a
      // duplicate: the rule never lets one entry fold into the other. It does
      // not make the pair unrelated. A correction and a contradiction differ
      // in exactly these words, so the judges still decide if the pair
      // contradicts, replaces or refines.
      const difference = factualDifference(entry.content, neighbour.content);

      if (!this.judges.available()) {
        reasons.add(KnowledgeEscalationReason.NO_LLM);

        if (difference) {
          Object.assign(neighbour, {
            relation: PageEntryRelationType.DISTINCT,
            decidedBy: PageEntryRelationDecider.RULE,
            reason: difference,
          });
        }
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

        if (
          neighbour.trust === KnowledgeTrustEnum.HUMAN_VERIFIED ||
          neighbour.locked
        ) {
          needsPerson = true;
        }
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

      // The judges agree that the two say the same thing, but the rule found
      // a difference. The rule wins, and the triage keeps both entries.
      if (difference && first.type === PageEntryRelationType.DUPLICATE) {
        Object.assign(neighbour, {
          relation: PageEntryRelationType.DISTINCT,
          decidedBy: PageEntryRelationDecider.RULE,
          models: asked,
          reason: `the judges said duplicate, but ${difference}`,
        });
        continue;
      }

      Object.assign(neighbour, {
        relation: first.type,
        decidedBy: PageEntryRelationDecider.MODEL,
        models: asked,
        reason: first.reason,
      });

      if (opposes(neighbour)) {
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
        neighbour.decidedBy === PageEntryRelationDecider.MODEL &&
        canFoldInto({
          status: neighbour.status,
          provisional: neighbour.trust === KnowledgeTrustEnum.PROVISIONAL,
        }),
    );
    const corroborates =
      foldsInto?.id ?? repeated?.id ?? nearDuplicate?.id ?? null;
    // What the entry it repeats must still be for folding this one in to
    // mean anything: live, and saying the same thing it said when compared.
    const corroboratesAsRead: Prisma.PageEntryWhereInput | null = foldsInto
      ? { content: foldsInto.content }
      : repeated
        ? { contentHash: repeated.contentHash }
        : nearDuplicate
          ? { content: nearDuplicate.content }
          : null;

    // Both acceptance judges found the evidence it cites says otherwise.
    let contradicted = false;

    // A repeat is folded into what it repeats rather than accepted, so what
    // acceptance asks of an entry does not apply to it.
    if (!corroborates) {
      // ---------------------------------------------------- 4. grounding
      // Evidence settles a claim, whoever wrote it. What an agent read cannot
      // be told (see `writerOf`), but a claim whose citations hold and which
      // both judges find the cited text supports is true whatever the agent
      // read. So who wrote it matters only when nothing confirms it.
      if (
        !entry.citations.some((citation) => READABLE.includes(citation.kind))
      ) {
        reasons.add(KnowledgeEscalationReason.UNGROUNDED);
      } else if (!grounded) {
        reasons.add(KnowledgeEscalationReason.CITATION_FAILED);
      }

      if (!grounded && writer.unknownSource) {
        reasons.add(KnowledgeEscalationReason.UNKNOWN_SOURCE);
      }

      // A convention is handed to every run in its modules, whether or not
      // it matches the work: accepting one pins it. A person decides a rule
      // nothing in the workspace states.
      if (!grounded && entry.kind === PageEntryKind.CONVENTION) {
        reasons.add(KnowledgeEscalationReason.PIN_REQUEST);
      }

      // How widely an unconfirmed claim is true is a person's call. The
      // evidence of a grounded one says where it holds.
      if (
        !grounded &&
        (!entry.scope?.trim() || entry.moduleIds.length > BROAD_SCOPE_MODULES)
      ) {
        reasons.add(KnowledgeEscalationReason.BROAD_SCOPE);
      }

      // The last check, and the only one asked of a model about the entry
      // itself: whether what it cites says what it claims. Not asked when a
      // person has to look anyway, nor when it cites nothing to read.
      const readable = entry.citations.some((citation) =>
        READABLE.includes(citation.kind),
      );

      if (!needsPerson && !hasHard(reasons) && readable) {
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

          const against = judgments.filter((judgment) => judgment.contradicted);

          // Both found the evidence says otherwise: the claim is wrong, and
          // is refused. One alone is a person's to settle. Short of that,
          // what the evidence does not settle is provisional.
          if (against.length === judgments.length) {
            contradicted = true;
          } else if (against.length > 0) {
            needsPerson = true;
            reasons.add(KnowledgeEscalationReason.EVIDENCE_DISPUTED);
          } else if (!judgments.every((judgment) => judgment.accept)) {
            reasons.add(KnowledgeEscalationReason.JUDGES_DISAGREE);
          }
        }
      }
    }

    // What the entry would be in use as. Provisional when only soft reasons
    // keep it from being accepted (see `SOFT_REASONS`).
    const provisional =
      !corroborates &&
      !contradicted &&
      !needsPerson &&
      !hasHard(reasons) &&
      reasons.size > 0;

    // A correction retires what it corrects. One nothing confirms does not:
    // a person decides whether it is right.
    if (provisional && supersedes && isServed(supersedes.status)) {
      reasons.add(KnowledgeEscalationReason.SUPERSEDE_REQUEST);
    }

    const wouldBe = {
      id: entry.id,
      trust: provisional
        ? KnowledgeTrustEnum.PROVISIONAL
        : entryTrust({
            status: PageEntryStatus.STANDING,
            verifiedAt: entry.verifiedAt,
            citations: entry.citations,
          }),
      createdAt: entry.createdAt,
    };

    // Which of two contradicting entries stands is precedence's to say, not
    // the model's. A grounded entry outranks every unverified neighbour, or
    // is the newer of two equals; a verified one escalated above. So only a
    // provisional entry is ever outranked, and it is not put in use against
    // something that stands higher.
    for (const neighbour of neighbours) {
      if (opposes(neighbour)) {
        neighbour.preferredId = preferred(wouldBe, {
          id: neighbour.id,
          trust: neighbour.trust,
          createdAt: neighbour.createdAt,
        }).id;
      }
    }

    const outranked = neighbours.some(
      (neighbour) =>
        opposes(neighbour) &&
        neighbour.preferredId === neighbour.id &&
        isServed(neighbour.status),
    );

    // ------------------------------------------------------- 5. decision
    const decision =
      needsPerson || hasHard(reasons)
        ? KnowledgeTriageDecisionType.ESCALATE
        : contradicted || outranked
          ? KnowledgeTriageDecisionType.REJECT
          : corroborates
            ? KnowledgeTriageDecisionType.CORROBORATE
            : reasons.size > 0
              ? KnowledgeTriageDecisionType.PROVISIONAL
              : KnowledgeTriageDecisionType.AUTO_ACCEPT;
    const accepted =
      decision === KnowledgeTriageDecisionType.AUTO_ACCEPT ||
      decision === KnowledgeTriageDecisionType.PROVISIONAL;

    const relations = [
      ...(repeatOf
        ? [
            {
              toId: repeatOf.id,
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
      policy:
        decision !== KnowledgeTriageDecisionType.REJECT
          ? null
          : contradicted
            ? KnowledgeTriagePolicy.CONTRADICTED
            : KnowledgeTriagePolicy.OUTRANKED,
      // What kept it from being accepted, for a provisional entry as for an
      // escalated one. A refusal rests on its policy.
      reasons:
        decision === KnowledgeTriageDecisionType.REJECT ? [] : [...reasons],
      corroborates:
        decision === KnowledgeTriageDecisionType.CORROBORATE
          ? corroborates
          : null,
      corroboratesAsRead,
      retires:
        supersedes && isServed(supersedes.status)
          ? {
              id: supersedes.id,
              status: supersedes.status,
              content: supersedes.content,
            }
          : null,
      // Served entries precedence ruled against, standing or consolidated,
      // and, for a grounded entry, provisional ones that say the same thing.
      // Only an accepted entry displaces anything, and only in `on` mode.
      displaces: accepted
        ? [
            ...neighbours.flatMap((neighbour) =>
              (opposes(neighbour) && neighbour.preferredId === entry.id) ||
              (grounded &&
                !provisional &&
                neighbour.relation === PageEntryRelationType.DUPLICATE &&
                neighbour.trust === KnowledgeTrustEnum.PROVISIONAL)
                ? [neighbour]
                : [],
            ),
            ...(grounded && !provisional
              ? repeats.filter(
                  (row) => isServed(row.status) && isProvisional(row),
                )
              : []),
          ]
            .filter((row) => isServed(row.status))
            .map((row) => ({
              id: row.id,
              status: row.status as PageEntryStatus,
              content: row.content,
              provisional:
                'trust' in row
                  ? row.trust === KnowledgeTrustEnum.PROVISIONAL
                  : isProvisional(row),
            }))
        : [],
      relations,
      // Waiting entries that say the same thing. Once this one is accepted,
      // each is triaged again and folds into it.
      sameAsWaiting: [
        ...repeats.filter((row) => !isServed(row.status)),
        ...neighbours.filter(
          (neighbour) =>
            neighbour.relation === PageEntryRelationType.DUPLICATE &&
            !isServed(neighbour.status),
        ),
      ].map((row) => row.id),
      models,
      outputs,
      inputs: {
        contentHash,
        kind: entry.kind,
        scope: entry.scope,
        moduleIds: entry.moduleIds,
        pageId: entry.pageId,
        supersedesId: entry.supersedesId,
        citations: citationsOf(entry),
        writer,
        cited: cited.targets,
        similarityThreshold: settings.similarityThreshold,
        repeats: repeatOf?.id ?? null,
        foldsInto: foldsInto?.id ?? null,
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
   * Served entries, written after this one, that triage found say the same
   * thing as it: by hash, or by two judges and no rule against it. Oldest
   * first.
   */
  private async servedDuplicatesOf(entry: TriagedEntry, workspaceId: string) {
    const rows = await this.prisma.pageEntryRelation.findMany({
      where: {
        toId: entry.id,
        type: PageEntryRelationType.DUPLICATE,
        decidedBy: {
          in: [PageEntryRelationDecider.HASH, PageEntryRelationDecider.MODEL],
        },
        from: {
          deleted: null,
          status: { in: SERVED },
          ...liveEntryIn(workspaceId),
        },
      },
      select: {
        from: {
          select: {
            id: true,
            content: true,
            status: true,
            provisionalSince: true,
            createdAt: true,
          },
        },
      },
    });

    return rows
      .map((row) => row.from)
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      );
  }

  /**
   * This method returns the nearest eligible entries in the same neighbourhood.
   * PostgreSQL supplies search ranks and authoritative status and module data.
   */
  private async nearNeighbours(
    entry: TriagedEntry,
    neighbourhood: Prisma.PageEntryWhereInput,
    minSimilarity: number,
  ): Promise<Neighbour[]> {
    const near = await this.vector.findNearEntries(
      entry.workspaceId,
      entry.content,
      {
        moduleIds: entry.moduleIds,
        pageId: entry.pageId,
        scope: entry.scope,
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
        provisionalSince: true,
        createdAt: true,
        page: { select: { entryPolicy: true } },
        citations: {
          select: { kind: true, checkResult: true, checkedAt: true },
        },
      },
    });

    return rows
      .map((row): Neighbour => ({
        id: row.id,
        content: row.content,
        similarity: similarity.get(row.id) ?? 0,
        status: row.status,
        trust: entryTrust(row),
        locked: row.page?.entryPolicy === PageEntryPolicy.LOCKED,
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
   * entry not written by a person has an unknown source. That counts against
   * an entry only when no evidence confirms it: a claim the workspace's own
   * code or issues support is true whatever its writer read. The runs are still
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
    trigger: KnowledgeTriageTrigger,
    auditRate: number,
    found: Found,
  ): Promise<TriageOutcome> {
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

        const applied = act ? await this.apply(tx, entry, found) : false;
        // Drawn from what was acted on without a person: whatever else was
        // decided reaches a person anyway. Never a refused credential, which
        // an audit would only put in front of more people, and never a
        // provisional entry: it is served as unverified, and evidence or use
        // settles it, not a person.
        const drawn =
          applied &&
          found.policy !== KnowledgeTriagePolicy.SECRET &&
          found.decision !== KnowledgeTriageDecisionType.PROVISIONAL;
        const audit = drawn && auditDraw(id) < auditRate;
        const outputs =
          notApplied !== undefined
            ? { ...found.outputs, notApplied }
            : found.outputs;

        // One look by the verifier, asked for with the escalation, so that a
        // person never sees the entry between the two.
        const verify =
          (found.decision === KnowledgeTriageDecisionType.ESCALATE ||
            found.decision === KnowledgeTriageDecisionType.PROVISIONAL) &&
          wantsVerifier(found.reasons, entry.citations, found.decision)
            ? (
                await tx.knowledgeVerification.createMany({
                  data: [{ entryId: entry.id, workspaceId: entry.workspaceId }],
                  skipDuplicates: true,
                })
              ).count > 0
            : false;

        const decision = await tx.knowledgeTriageDecision.create({
          data: {
            id,
            entryId: entry.id,
            workspaceId: entry.workspaceId,
            decision: found.decision,
            reasons: found.reasons,
            policy: found.policy,
            mode,
            trigger,
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

        return { id: decision.id, applied, audit, verify };
      });

    let result: {
      id: string;
      applied: boolean;
      audit: boolean;
      verify: boolean;
    };

    try {
      result = await write(mode === KnowledgeTriageMode.ON);
    } catch (error) {
      if (!(error instanceof StaleTriage)) {
        throw error;
      }

      // Rolled back: record what was decided, and that it was not acted on.
      result = await write(false, error.message);
    }

    if (result.verify) {
      await this.verifyLater(entry.id);
    }

    if (
      result.applied &&
      (found.decision === KnowledgeTriageDecisionType.AUTO_ACCEPT ||
        found.decision === KnowledgeTriageDecisionType.PROVISIONAL)
    ) {
      await this.answerGapsQuietly(entry.id);
      await this.triageAgain(
        found.sameAsWaiting ?? [],
        KnowledgeTriageTrigger.RELATED,
      );
    }

    return {
      trigger,
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
   * Queues the look of the verifier. Best effort: the nightly sweep queues a
   * look whose job was not queued.
   */
  private async verifyLater(entryId: string): Promise<void> {
    try {
      await this.pagesQueue?.add(
        VERIFY_ENTRY_JOB,
        { entryId },
        verifyEntryJobOptions(entryId),
      );
    } catch (error) {
      this.logger.warn({
        message: `Could not queue the verifier for entry ${entryId}: ${error}; the nightly sweep will`,
        where: 'KnowledgeTriageService.verifyLater',
      });
    }
  }

  /**
   * Queues a pass for entries that wait with nothing triage acted on under
   * the rules it decides by now: those whose every pass failed, those
   * decided under an earlier `TRIAGE_POLICY_VERSION`, and, where triage is
   * now on, those it decided about only in shadow. Only entries older than
   * an hour, so a pass still being tried is not doubled. Returns how many it
   * queued.
   */
  async sweep(env: NodeJS.ProcessEnv = process.env): Promise<number> {
    const waiting: Prisma.PageEntryWhereInput = {
      deleted: null,
      status: PageEntryStatus.PROPOSED,
      createdAt: { lt: new Date(Date.now() - TRIAGE_SWEEP_AFTER_MS) },
      ...onLivePageOrLoose(),
    };
    const current: Prisma.KnowledgeTriageDecisionWhereInput = {
      inputs: { path: ['policyVersion'], equals: TRIAGE_POLICY_VERSION },
    };
    const select = {
      id: true,
      workspace: { select: { preferences: true } },
    } as const;
    const [undecided, shadowed] = await Promise.all([
      this.prisma.pageEntry.findMany({
        where: { ...waiting, triageDecisions: { none: current } },
        orderBy: { createdAt: 'asc' },
        take: TRIAGE_SWEEP_LIMIT,
        select,
      }),
      this.prisma.pageEntry.findMany({
        where: {
          ...waiting,
          triageDecisions: {
            some: { ...current, mode: KnowledgeTriageMode.SHADOW },
            none: { ...current, mode: KnowledgeTriageMode.ON },
          },
        },
        orderBy: { createdAt: 'asc' },
        take: TRIAGE_SWEEP_LIMIT,
        select,
      }),
    ]);
    const triageIs = (entry: (typeof undecided)[number]) =>
      knowledgeSettings(entry.workspace?.preferences, env).autoTriage;
    const entryIds = [
      ...undecided.filter((entry) => triageIs(entry) !== 'off'),
      ...shadowed.filter((entry) => triageIs(entry) === 'on'),
    ].map((entry) => entry.id);

    await this.triageAgain(entryIds, KnowledgeTriageTrigger.WRITTEN);

    return entryIds.length;
  }

  /**
   * Queues one more pass for each of these entries. Best effort: an entry
   * that is not triaged again waits for a person, as it did before.
   */
  private async triageAgain(
    entryIds: string[],
    trigger: KnowledgeTriageTrigger,
  ): Promise<void> {
    for (const entryId of new Set(entryIds)) {
      try {
        await this.pagesQueue?.add(
          TRIAGE_ENTRY_JOB,
          { entryId, trigger },
          retriageJobOptions(entryId, trigger),
        );
      } catch (error) {
        this.logger.warn({
          message: `Could not queue triage of entry ${entryId} again (${trigger}): ${error}; it waits for a person`,
          where: 'KnowledgeTriageService.triageAgain',
        });
      }
    }
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
  ): Promise<boolean> {
    const provisional = isProvisional(entry);
    let data: Prisma.PageEntryUpdateManyMutationInput;

    switch (found.decision) {
      case KnowledgeTriageDecisionType.ESCALATE:
        // An escalation waits for a person, whatever the mode. A
        // provisional entry stops being served while it waits.
        if (!provisional) {
          return false;
        }
        data = { status: PageEntryStatus.PROPOSED, provisionalSince: null };
        break;
      case KnowledgeTriageDecisionType.PROVISIONAL:
        // Already in use as provisional: nothing to change.
        if (provisional) {
          return false;
        }
        data = {
          status: PageEntryStatus.STANDING,
          provisionalSince: new Date(),
        };
        break;
      case KnowledgeTriageDecisionType.AUTO_ACCEPT:
        // Accepted outright, or promoted from provisional.
        data = { status: PageEntryStatus.STANDING, provisionalSince: null };
        break;
      default:
        data = { status: PageEntryStatus.ARCHIVED, provisionalSince: null };
    }

    const { count } = await tx.pageEntry.updateMany({
      where: {
        id: entry.id,
        deleted: null,
        status: entry.status,
        updatedAt: entry.updatedAt,
      },
      data,
    });

    if (count === 0) {
      throw new StaleTriage('the entry changed while it was triaged');
    }

    // Taking a provisional entry out of use is not acting on the escalation:
    // what it escalated still waits for a person, and the decision is
    // recorded as not applied, as every escalation is.
    if (found.decision === KnowledgeTriageDecisionType.ESCALATE) {
      return false;
    }

    if (found.corroborates) {
      const { count: corroborated } = await tx.pageEntry.updateMany({
        where: {
          id: found.corroborates,
          deleted: null,
          status: { in: NEIGHBOUR_STATUSES },
          ...onLivePageOrLoose(),
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

      // Said again by enough separate writes, a provisional claim is settled.
      await tx.pageEntry.updateMany({
        where: {
          id: found.corroborates,
          status: PageEntryStatus.STANDING,
          provisionalSince: { not: null },
          corroborationCount: { gte: PROVISIONAL_PROMOTE_CORROBORATIONS },
        },
        data: { provisionalSince: null },
      });
    }

    // Disputed rather than superseded: withheld until a person looks, and
    // reversible, because a model found the contradiction. A provisional
    // entry is archived instead: nobody vouched for it, and what replaces it
    // ranks at least as high. Each only as it was compared: a person
    // verifying it, rewording it or locking its page since takes it out of
    // what precedence decided about.
    if (
      found.decision === KnowledgeTriageDecisionType.AUTO_ACCEPT ||
      found.decision === KnowledgeTriageDecisionType.PROVISIONAL
    ) {
      for (const displaced of found.displaces ?? []) {
        const { count: disputed } = await tx.pageEntry.updateMany({
          where: {
            id: displaced.id,
            deleted: null,
            status: displaced.status,
            verifiedAt: null,
            content: displaced.content,
            ...(displaced.provisional && { provisionalSince: { not: null } }),
            ...onUnlockedPageOrLoose(),
          },
          data: displaced.provisional
            ? { status: PageEntryStatus.ARCHIVED, provisionalSince: null }
            : { status: PageEntryStatus.DISPUTED },
        });

        if (disputed === 0) {
          throw new StaleTriage(
            `the entry it contradicts, ${displaced.id}, changed while it was triaged`,
          );
        }
      }

      // Retired as a person's acceptance retires it: only as it was read,
      // and never once a person has verified it or locked its page since.
      if (found.retires) {
        const { count: retired } = await tx.pageEntry.updateMany({
          where: {
            id: found.retires.id,
            deleted: null,
            status: found.retires.status,
            verifiedAt: null,
            content: found.retires.content,
            ...onUnlockedPageOrLoose(),
          },
          data: { status: PageEntryStatus.SUPERSEDED },
        });

        if (retired === 0) {
          throw new StaleTriage(
            `the entry it corrects, ${found.retires.id}, changed while it was triaged`,
          );
        }
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
  /** The served entry it corrects, as read; accepting it retires that one. */
  retires?: { id: string; status: PageEntryStatus; content: string } | null;
  /**
   * Served entries it replaces, with their content as read: those precedence
   * ruled against, and provisional ones a grounded entry says again.
   */
  displaces?: Array<{
    id: string;
    status: PageEntryStatus;
    content: string;
    provisional: boolean;
  }>;
  /** Waiting entries that say the same thing, to triage again on acceptance. */
  sameAsWaiting?: string[];
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
 * Whether the verifier looks for evidence: before a person sees an escalated
 * entry, or to settle a provisional one. It looks when the entry cites
 * nothing that can be checked, and when what it cited no longer holds; for a
 * provisional entry, also when the judges did not find that what it cites
 * settles it. It does not look while a citation is still unread: the retry
 * reads it, and triage then decides again.
 */
export function wantsVerifier(
  reasons: KnowledgeEscalationReason[],
  citations: Array<{ checkResult: string | null }>,
  decision: KnowledgeTriageDecisionType = KnowledgeTriageDecisionType.ESCALATE,
): boolean {
  if (
    reasons.includes(KnowledgeEscalationReason.UNGROUNDED) ||
    (decision === KnowledgeTriageDecisionType.PROVISIONAL &&
      reasons.includes(KnowledgeEscalationReason.JUDGES_DISAGREE))
  ) {
    return true;
  }

  return (
    reasons.includes(KnowledgeEscalationReason.CITATION_FAILED) &&
    citations.every((citation) => citation.checkResult !== 'UNKNOWN') &&
    citations.some((citation) => FAILED.has(citation.checkResult ?? ''))
  );
}

/** Results under which a citation no longer supports its claim. */
const FAILED = new Set<string>(['CHANGED', 'MISSING']);

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

  if (citation.kind === PageEntryCitationKind.URL) {
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

/** The citations of an entry, as a decision records them. */
function citationsOf(entry: TriagedEntry) {
  return entry.citations
    .map((citation) => ({
      kind: citation.kind,
      path: citation.path,
      startLine: citation.startLine,
      endLine: citation.endLine,
      targetId: citation.targetId,
      ...(citation.kind === PageEntryCitationKind.URL && {
        url: citation.targetLabel,
      }),
      result: citation.checkResult,
    }))
    .sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
}

/**
 * What a decision about an entry rests on, and what a later pass compares:
 * its content, its citations with their results, and the served entries
 * that say the same thing.
 */
function evidenceOfEntry(
  entry: TriagedEntry,
  servedDuplicates: Array<{ id: string }>,
) {
  return {
    contentHash: entry.contentHash ?? contentHashOf(entry.content),
    citations: citationsOf(entry),
    servedDuplicates: servedDuplicates.map((row) => row.id).sort(),
  };
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
