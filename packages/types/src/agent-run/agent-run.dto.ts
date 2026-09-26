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
  AGENT_RUN_STATUSES,
  type AgentRunDelivery,
  type AgentRunEventLevel,
  type AgentRunPhases,
  type AgentRunStatus,
} from './agent-run.entity';
import { THINKING_LEVELS, type ThinkingLevel } from './model-providers';

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

  @IsOptional()
  @IsInt()
  @Min(1)
  maxCycles?: number;
}

export class AgentRunPhasesDto implements AgentRunPhases {
  @IsOptional()
  @IsBoolean()
  review?: boolean;
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

  /**
   * Which of the workspace's model keys this run uses, and what it asks for.
   *
   * The provider is load-bearing rather than descriptive: it selects the key,
   * and with it the environment variable the harness reads that key from.
   */
  @IsOptional()
  @IsString()
  provider?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsIn(THINKING_LEVELS)
  thinking?: ThinkingLevel;

  @IsOptional()
  @ValidateNested()
  @Type(() => AgentRunLimitsDto)
  limits?: AgentRunLimitsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => AgentRunPhasesDto)
  phases?: AgentRunPhasesDto;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class CreateAgentRunDto {
  @IsString()
  issueId: string;

  /**
   * What the person delegating knows that the issue does not say.
   *
   * Its own field rather than something folded into the description, and not a
   * criterion either: a criterion is a thing the work is judged against, and
   * this is a thing the work should take into account — "follow the spec style
   * in this folder", "do not touch the migration". Three different objects, so
   * three different fields.
   *
   * The highest-leverage input a delegating human has, and the only one with
   * no sensible default.
   */
  @IsOptional()
  @IsString()
  guidance?: string;

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
