import { LLMRoles, type LLMRole } from '@vantikhq/types';
import { IsIn, IsOptional, IsString } from 'class-validator';

export class PromptInput {
  @IsString()
  name: string;

  @IsString()
  prompt: string;

  // Named `model` to match the column. It was `models` before, so it never
  // bound to anything and the validator never ran.
  @IsOptional()
  @IsIn(LLMRoles)
  model: LLMRole;
}
