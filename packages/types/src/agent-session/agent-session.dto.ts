import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import {
  AGENT_SESSION_EXTERNAL_ID_MAX,
  type AgentSessionChannel,
} from './agent-session.entity';

/**
 * Links a harness session to an issue. Only the hooks channel is open to a
 * caller: the server writes the other channels.
 */
export class LinkAgentSessionDto {
  @IsString()
  @IsNotEmpty()
  issueId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(AGENT_SESSION_EXTERNAL_ID_MAX)
  externalId: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  harness?: string;

  @IsIn(['HOOKS'])
  channel: Extract<AgentSessionChannel, 'HOOKS'>;
}
