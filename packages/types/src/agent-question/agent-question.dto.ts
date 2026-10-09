import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { AGENT_QUESTION_LIMITS } from './agent-question.entity';

export class AgentQuestionAnswerDto {
  @IsString()
  @MaxLength(AGENT_QUESTION_LIMITS.id)
  id: string;

  @IsArray()
  @ArrayMaxSize(AGENT_QUESTION_LIMITS.options)
  @IsString({ each: true })
  selected: string[];

  @IsOptional()
  @IsString()
  @MaxLength(AGENT_QUESTION_LIMITS.other)
  other?: string;
}

/** The answers of a person to an open question. */
export class AnswerAgentQuestionDto {
  @IsArray()
  @ArrayMaxSize(AGENT_QUESTION_LIMITS.questions)
  @ValidateNested({ each: true })
  @Type(() => AgentQuestionAnswerDto)
  answers: AgentQuestionAnswerDto[];
}
