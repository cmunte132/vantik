import { Injectable } from '@nestjs/common';
import {
  KnowledgeTriageDecisionType,
  KnowledgeVerdict,
  PageEntryStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { LoggerService } from 'modules/logger/logger.service';

import {
  knowledgeSettings,
  type KnowledgeSettings,
} from '../knowledge-settings';
import {
  ACTING_DECISIONS,
  type ActingDecision,
  agreementByType,
  agrees,
  isActing,
  shouldBackOff,
  type TypeAgreement,
  weightOf,
} from './agreement';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Enough of a Prisma client to read agreement with, in a transaction or not. */
type Reader = Pick<
  Prisma.TransactionClient,
  'knowledgeTriageDecision' | 'knowledgeBackoffChange'
>;

/** What a person's change to an entry does, as a verdict reads it. */
export interface EntryChange {
  /** The status asked for, which may be the one the entry already has. */
  status?: PageEntryStatus | string;
  /** Whether what it says, where it applies or its kind changed. */
  edited: boolean;
}

/** A decision type's state, as the latest change left it. */
export interface BackoffState {
  backedOff: boolean;
  changedAt: Date | null;
}

/** A decision type stopping or resuming, as it was recorded. */
export interface BackoffChange {
  decision: ActingDecision;
  backedOff: boolean;
  kappa: number | null;
  samples: number;
}

/** Agreement per decision type in a workspace, and whether each is acting. */
export interface AgreementReport {
  autoTriage: KnowledgeSettings['autoTriage'];
  windowDays: number;
  since: Date;
  kappaFloor: number;
  kappaMinSamples: number;
  auditRate: number;
  types: Array<TypeAgreement & BackoffState>;
}

/**
 * The verdict a person's change to an entry gives, or null when it gives
 * none: accepting (or folding it into the page) keeps it, archiving or
 * disputing it takes it out of use, and changing what it says, where it
 * applies or its kind edits it. Confirming it alone decides nothing about
 * whether it stays.
 */
export function verdictOf(change: EntryChange): KnowledgeVerdict | null {
  if (change.edited) {
    return KnowledgeVerdict.EDITED;
  }

  switch (change.status) {
    case PageEntryStatus.STANDING:
    case PageEntryStatus.CONSOLIDATED:
      return KnowledgeVerdict.ACCEPTED;
    case PageEntryStatus.ARCHIVED:
    case PageEntryStatus.DISPUTED:
      return KnowledgeVerdict.REJECTED;
    default:
      return null;
  }
}

/**
 * Each acting decision type's state in a workspace. Read by triage before it
 * acts, and by the report.
 */
export async function backoffState(
  client: Pick<Prisma.TransactionClient, 'knowledgeBackoffChange'>,
  workspaceId: string,
): Promise<Map<ActingDecision, BackoffState>> {
  const state = new Map<ActingDecision, BackoffState>();

  for (const decision of ACTING_DECISIONS) {
    const latest = await client.knowledgeBackoffChange.findFirst({
      where: { workspaceId, decision },
      orderBy: { createdAt: 'desc' },
      select: { backedOff: true, createdAt: true },
    });

    state.set(decision, {
      backedOff: latest?.backedOff ?? false,
      changedAt: latest?.createdAt ?? null,
    });
  }

  return state;
}

/**
 * People's verdicts on triage decisions, the agreement measured from them,
 * and the back-off that agreement drives.
 *
 * A verdict is recorded when a person first acts on an entry that reached
 * them because of triage: one waiting in the inbox, whatever triage decided
 * about it (an escalation, or anything in shadow mode), or one drawn for
 * audit. Nothing else a person does to an entry is a verdict, because the
 * entries people happen to act on later are not a sample of anything.
 */
@Injectable()
export default class KnowledgeAgreementService {
  private readonly logger = new LoggerService('KnowledgeAgreement');

  constructor(private prisma: PrismaService) {}

  /**
   * The writes that record a person's verdict on each of these entries, to
   * run in the same transaction as the change itself, the decisions they
   * give a verdict on, and the workspaces to re-evaluate once it commits.
   * Each entry is given with its status before the change. An entry with no
   * open decision gets nothing.
   *
   * `strict` names a decision whose verdict must be this one: its write then
   * fails, and with it the whole transaction, when another verdict landed
   * first. An audit answered as such needs that, or two people answering at
   * once would leave the entry as the second left it and the verdict as the
   * first gave it.
   */
  async verdictsFor(
    entries: ReadonlyArray<{ id: string; status: string }>,
    change: EntryChange,
    userId: string,
    options: { strict?: string } = {},
  ): Promise<{
    operations: Array<Prisma.PrismaPromise<unknown>>;
    decisionIds: string[];
    workspaceIds: string[];
  }> {
    const verdict = verdictOf(change);

    if (!verdict || entries.length === 0) {
      return { operations: [], decisionIds: [], workspaceIds: [] };
    }

    const open = await this.prisma.knowledgeTriageDecision.findMany({
      where: { entryId: { in: entries.map((entry) => entry.id) } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        entryId: true,
        workspaceId: true,
        decision: true,
        reasons: true,
        policy: true,
        backedOffFrom: true,
        audit: true,
        applied: true,
        corroboratedEntryId: true,
        verdict: true,
      },
    });
    const statusOf = new Map(entries.map((entry) => [entry.id, entry.status]));
    const seen = new Set<string>();
    const operations: Array<Prisma.PrismaPromise<unknown>> = [];
    const decisionIds: string[] = [];
    const workspaceIds = new Set<string>();
    const verdictAt = new Date();

    for (const decision of open) {
      // Only the latest decision about an entry is open to a verdict.
      if (seen.has(decision.entryId)) {
        continue;
      }

      seen.add(decision.entryId);

      if (
        decision.verdict !== null ||
        (statusOf.get(decision.entryId) !== PageEntryStatus.PROPOSED &&
          !decision.audit)
      ) {
        continue;
      }

      // Conditional, so of two people acting at once only the first gives
      // the verdict.
      const where: Prisma.KnowledgeTriageDecisionWhereUniqueInput = {
        id: decision.id,
        verdict: null,
      };
      const data = {
        verdict,
        agreed: agrees(decision, verdict),
        verdictById: userId,
        verdictAt,
      };

      operations.push(
        decision.id === options.strict
          ? this.prisma.knowledgeTriageDecision.update({ where, data })
          : this.prisma.knowledgeTriageDecision.updateMany({ where, data }),
      );
      decisionIds.push(decision.id);
      workspaceIds.add(decision.workspaceId);

      // A repeat triage folded in and a person puts back into use was not a
      // repeat, so the corroboration it counted is taken back.
      if (
        decision.decision === KnowledgeTriageDecisionType.CORROBORATE &&
        decision.applied &&
        decision.corroboratedEntryId &&
        change.status === PageEntryStatus.STANDING
      ) {
        operations.push(
          this.prisma.pageEntry.updateMany({
            where: {
              id: decision.corroboratedEntryId,
              corroborationCount: { gt: 0 },
            },
            data: { corroborationCount: { decrement: 1 } },
          }),
        );
      }
    }

    return { operations, decisionIds, workspaceIds: [...workspaceIds] };
  }

  /**
   * Agreement per measured decision type over the window, from the verdicts
   * given in it.
   */
  async measure(
    client: Reader,
    workspaceId: string,
    settings: KnowledgeSettings,
    now = new Date(),
  ): Promise<{ since: Date; types: TypeAgreement[] }> {
    const since = new Date(now.getTime() - settings.kappaWindowDays * DAY_MS);
    const rows = await client.knowledgeTriageDecision.findMany({
      where: {
        workspaceId,
        verdict: { not: null },
        verdictAt: { gte: since },
      },
      select: {
        decision: true,
        reasons: true,
        policy: true,
        backedOffFrom: true,
        verdict: true,
        audit: true,
        auditRate: true,
      },
    });

    return {
      since,
      types: agreementByType(
        rows.map((row) => ({
          ...row,
          verdict: row.verdict as KnowledgeVerdict,
          weight: weightOf(row),
        })),
      ),
    };
  }

  /**
   * Measures agreement again and records each decision type whose state it
   * changes: backed off when its kappa falls under the floor over enough
   * verdicts, resumed when it is back at the floor over enough. Run after
   * verdicts arrive. One re-evaluation at a time per workspace, so two
   * verdicts landing together cannot both record the same change.
   */
  async reevaluate(
    workspaceId: string,
    env: NodeJS.ProcessEnv = process.env,
    now = new Date(),
  ): Promise<BackoffChange[]> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { preferences: true },
    });
    const settings = knowledgeSettings(workspace?.preferences, env);

    const changes = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`knowledge-backoff:${workspaceId}`}, 0))`;

      const { types } = await this.measure(tx, workspaceId, settings, now);
      const state = await backoffState(tx, workspaceId);
      const made: BackoffChange[] = [];

      for (const agreement of types) {
        // Escalation is measured but never backs off: it already waits on a
        // person.
        if (!isActing(agreement.decision)) {
          continue;
        }

        const decision = agreement.decision;
        const was = state.get(decision)?.backedOff ?? false;
        const backedOff = shouldBackOff(agreement, settings, was);

        if (backedOff === was) {
          continue;
        }

        await tx.knowledgeBackoffChange.create({
          data: {
            workspaceId,
            decision,
            backedOff,
            kappa: agreement.kappa,
            samples: agreement.samples,
            floor: settings.kappaFloor,
            minSamples: settings.kappaMinSamples,
            windowDays: settings.kappaWindowDays,
          },
        });
        made.push({
          decision,
          backedOff,
          kappa: agreement.kappa,
          samples: agreement.samples,
        });
      }

      return made;
    });

    // Logged once committed, so a change that was rolled back is not.
    for (const change of changes) {
      const kappa =
        change.kappa === null ? 'undefined' : change.kappa.toFixed(2);

      this.logger.info({
        message: change.backedOff
          ? `Triage stopped acting on ${change.decision} in workspace ${workspaceId}: kappa ${kappa} over ${change.samples} verdicts, under the floor of ${settings.kappaFloor}. A person decides these until agreement recovers.`
          : `Triage resumed acting on ${change.decision} in workspace ${workspaceId}: kappa ${kappa} over ${change.samples} verdicts, at or above the floor of ${settings.kappaFloor}.`,
        where: 'KnowledgeAgreementService.reevaluate',
        payload: {
          workspaceId,
          ...change,
          floor: settings.kappaFloor,
          minSamples: settings.kappaMinSamples,
          windowDays: settings.kappaWindowDays,
        },
      });
    }

    return changes;
  }

  /**
   * Re-evaluates each workspace, and never fails the caller for it: the
   * person's action has already been made, and the next verdict re-evaluates
   * again.
   */
  async reevaluateQuietly(workspaceIds: string[]): Promise<void> {
    for (const workspaceId of workspaceIds) {
      try {
        await this.reevaluate(workspaceId);
      } catch (error) {
        this.logger.error({
          message: `Agreement could not be re-evaluated for workspace ${workspaceId}`,
          where: 'KnowledgeAgreementService.reevaluateQuietly',
          error: error as Error,
        });
      }
    }
  }

  /** Agreement per decision type, with each type's state, for the people running triage. */
  async report(
    workspaceId: string,
    env: NodeJS.ProcessEnv = process.env,
    now = new Date(),
  ): Promise<AgreementReport> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { preferences: true },
    });
    const settings = knowledgeSettings(workspace?.preferences, env);
    const { since, types } = await this.measure(
      this.prisma,
      workspaceId,
      settings,
      now,
    );
    const state = await backoffState(this.prisma, workspaceId);

    return {
      autoTriage: settings.autoTriage,
      windowDays: settings.kappaWindowDays,
      since,
      kappaFloor: settings.kappaFloor,
      kappaMinSamples: settings.kappaMinSamples,
      auditRate: settings.auditRate,
      types: types.map((agreement) => ({
        ...agreement,
        ...((isActing(agreement.decision) && state.get(agreement.decision)) || {
          backedOff: false,
          changedAt: null,
        }),
      })),
    };
  }
}
