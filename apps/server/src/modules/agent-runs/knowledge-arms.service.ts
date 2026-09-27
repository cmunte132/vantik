import { Injectable } from '@nestjs/common';
import {
  AGENT_RUN_TRANSITIONS,
  type AgentRunStatus,
  isTerminalAgentRunStatus,
  type KnowledgeArmComparison,
  KnowledgeArmEnum,
  type KnowledgeArmMean,
  type KnowledgeArmRate,
  type KnowledgeArmStats,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { knowledgeSettings } from 'modules/pages/knowledge-settings';

/** One finished run, as the comparison reads it. */
export interface ArmRun {
  knowledgeArm: string | null;
  result: unknown;
  pullRequestOutcome: string | null;
  /** The last pass's checks: passed, failed, or null when none ran. */
  lastVerificationPassed: boolean | null;
  passes: number;
}

const FINISHED = (
  Object.keys(AGENT_RUN_TRANSITIONS) as AgentRunStatus[]
).filter(isTerminalAgentRunStatus);

/**
 * The runs that were handed knowledge beside the runs held out from it.
 *
 * Every number carries what it was measured over. An arm is a tenth of the
 * runs by default, so for a long while it is a handful, and a rate over a
 * handful says very little; the panel shows the sample beside each rate so
 * nobody reads 100% off two runs as a result.
 */
@Injectable()
export class KnowledgeArmsService {
  constructor(private prisma: PrismaService) {}

  async compare(
    workspaceId: string,
    since?: Date | null,
  ): Promise<KnowledgeArmComparison> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { preferences: true },
    });
    const rows = await this.prisma.agentRun.findMany({
      where: {
        workspaceId,
        deleted: null,
        knowledgeArm: { not: null },
        status: { in: FINISHED },
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      select: {
        knowledgeArm: true,
        result: true,
        pullRequestOutcome: true,
        iterations: {
          orderBy: { index: 'desc' },
          take: 1,
          select: { verificationPassed: true },
        },
        _count: { select: { iterations: true } },
      },
    });

    return {
      holdoutRate: knowledgeSettings(workspace?.preferences).holdoutRate,
      since: since?.toISOString() ?? null,
      arms: compareArms(
        rows.map((row) => ({
          knowledgeArm: row.knowledgeArm,
          result: row.result,
          pullRequestOutcome: row.pullRequestOutcome,
          lastVerificationPassed: row.iterations[0]?.verificationPassed ?? null,
          passes: row._count.iterations,
        })),
      ),
    };
  }
}

/** Both arms, treatment first, each summarised over its runs. */
export function compareArms(runs: ArmRun[]): KnowledgeArmStats[] {
  return [KnowledgeArmEnum.TREATMENT, KnowledgeArmEnum.HOLDOUT].map((arm) =>
    armStats(
      arm,
      runs.filter((run) => run.knowledgeArm === arm),
    ),
  );
}

function armStats(arm: KnowledgeArmEnum, runs: ArmRun[]): KnowledgeArmStats {
  const verified = runs.filter((run) => run.lastVerificationPassed !== null);
  const merged = runs.filter((run) => run.pullRequestOutcome === 'MERGED');
  const closed = runs.filter((run) => run.pullRequestOutcome === 'CLOSED');
  const opened = runs.filter((run) => pullRequestOf(run.result));

  return {
    arm,
    runs: runs.length,
    verification: rate(
      verified.filter((run) => run.lastVerificationPassed === true).length,
      verified.length,
    ),
    // A run that never reached a pass (it failed setting up) has no passes to
    // count, and counting it as nought would reward failing early.
    reviewPasses: mean(
      runs.filter((run) => run.passes > 0).map((run) => run.passes),
    ),
    costUsd: mean(
      runs
        .map((run) => costOf(run.result))
        .filter((cost): cost is number => cost !== null),
    ),
    merged: rate(merged.length, merged.length + closed.length),
    openPullRequests: opened.filter((run) => !run.pullRequestOutcome).length,
  };
}

function rate(count: number, of: number): KnowledgeArmRate {
  return { count, of, rate: of > 0 ? count / of : null };
}

function mean(values: number[]): KnowledgeArmMean {
  return {
    mean: values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null,
    runs: values.length,
  };
}

function field(result: unknown, key: string): unknown {
  return result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)[key]
    : undefined;
}

function costOf(result: unknown): number | null {
  const cost = field(result, 'costUsd');

  return typeof cost === 'number' && Number.isFinite(cost) ? cost : null;
}

function pullRequestOf(result: unknown): boolean {
  const url = field(result, 'prUrl');

  return typeof url === 'string' && url.length > 0;
}
