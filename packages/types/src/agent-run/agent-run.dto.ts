import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

import {
  AGENT_RUN_DELIVERIES,
  AGENT_RUN_EVENT_LEVELS,
  AGENT_RUN_FAILURES,
  AGENT_RUN_STATUSES,
  type AgentRunDelivery,
  type AgentRunEventLevel,
  type AgentRunFailure,
  type AgentRunStatus,
} from './agent-run.entity';

export class AgentRunLimitsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  maxDurationMs?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxTokens?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxIterations?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxCostUsd?: number;
}

export class AgentRunConfigDto {
  @IsOptional()
  @IsString()
  repoUrl?: string;

  @IsOptional()
  @IsString()
  repoPath?: string;

  @IsOptional()
  @IsIn(AGENT_RUN_DELIVERIES)
  delivery?: AgentRunDelivery;

  @IsOptional()
  @IsString()
  worktreeRoot?: string;

  @IsOptional()
  @IsString()
  baseBranch?: string;

  @IsOptional()
  @IsString()
  branchPrefix?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  setupCommands?: string[];

  @IsOptional()
  @IsString()
  testCommand?: string;

  @IsOptional()
  @IsString()
  lintCommand?: string;

  @IsOptional()
  @IsString()
  typecheckCommand?: string;

  @IsOptional()
  @IsString()
  buildCommand?: string;

  @IsOptional()
  @IsString()
  harnessCommand?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AgentRunLimitsDto)
  limits?: AgentRunLimitsDto;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class CreateAgentRunDto {
  @IsString()
  issueId: string;

  /**
   * The AGENT user to delegate to. Optional: with one agent in the workspace
   * the caller should not have to name it.
   */
  @IsOptional()
  @IsString()
  agentUserId?: string;

  @IsOptional()
  @IsString()
  executor?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AgentRunConfigDto)
  config?: AgentRunConfigDto;

  /**
   * Start a run even though the issue already has a live one.
   *
   * Two agents on one issue produce two branches nobody asked for, so it is
   * refused by default and this is the deliberate override.
   */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class AgentRunFilterDto {
  @IsOptional()
  @IsString()
  issueId?: string;

  @IsOptional()
  @IsString()
  agentUserId?: string;

  @IsOptional()
  @IsArray()
  @IsIn(AGENT_RUN_STATUSES, { each: true })
  status?: AgentRunStatus[];

  @IsOptional()
  @IsString()
  executor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  perPage?: number;
}

export class AgentRunRequestParamsDto {
  @IsString()
  agentRunId: string;
}

export class AppendAgentRunEventDto {
  @IsString()
  message: string;

  @IsOptional()
  @IsIn(AGENT_RUN_EVENT_LEVELS)
  level?: AgentRunEventLevel;

  @IsOptional()
  @IsString()
  phase?: string;

  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;

  /** ISO timestamp of when it happened, if that differs from arrival. */
  @IsOptional()
  @IsString()
  at?: string;
}

export class CancelAgentRunDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

/**
 * The terminal report. Deliberately does not accept a status: the outcome is
 * derived from `failure` being present or absent, so a runner cannot claim
 * SUCCEEDED while also reporting why it failed.
 */
export class ReportAgentRunDto {
  @IsOptional()
  @IsIn(AGENT_RUN_FAILURES)
  failure?: AgentRunFailure;

  @IsOptional()
  @IsString()
  summary?: string;

  @IsOptional()
  @IsString()
  error?: string;

  @IsOptional()
  @IsIn(AGENT_RUN_DELIVERIES)
  delivery?: AgentRunDelivery;

  @IsOptional()
  @IsString()
  branch?: string;

  @IsOptional()
  @IsString()
  prUrl?: string;

  /** Absolute path of the worktree holding the branch, for local delivery. */
  @IsOptional()
  @IsString()
  worktreePath?: string;

  @IsOptional()
  @IsString()
  headCommit?: string;

  @IsOptional()
  @IsString()
  baseCommit?: string;

  @IsOptional()
  @IsString()
  harnessVersion?: string;

  @IsOptional()
  @IsString()
  modelId?: string;

  @IsOptional()
  @IsObject()
  counters?: Record<string, number>;

  @IsOptional()
  @IsObject()
  phaseTimings?: Record<string, number>;

  @IsOptional()
  @IsInt()
  @Min(0)
  iterationCount?: number;

  /**
   * Route to human review instead of reporting success — the issue was not
   * test-specifiable, or the loop aborted on a widening Δ.
   */
  @IsOptional()
  @IsBoolean()
  needsReview?: boolean;
}
