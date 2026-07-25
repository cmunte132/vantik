import { AGENT_SCOPES, AgentScope, Invite, User } from '@vantikhq/types';
import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';

export class UserIdParams {
  @IsString()
  userId: string;
}

export class UpdateUserBody {
  @IsString()
  fullname: string;

  @IsString()
  username: string;
}

export class UserIdsBody {
  @IsArray()
  userIds: string[];
}

export class CreateAgentDto {
  @IsString()
  name: string;

  /**
   * What the agent may do. Omit for the default — read and write, but not
   * delete. Unknown values are dropped rather than rejected, so a client asking
   * for a scope this server does not have still gets a usable agent.
   */
  @IsOptional()
  @IsArray()
  @IsIn(AGENT_SCOPES, { each: true })
  scopes?: AgentScope[];
}

export class AgentIdParams {
  @IsString()
  agentId: string;
}

export interface PublicUser {
  id: string;
  username: string;
  fullname: string;
  email: string;
}

export interface UserWithInvites extends User {
  invites: Invite[];
}

export function userSerializer(user: User) {
  return {
    id: user.id,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    email: user.email,
    fullname: user.fullname,
    username: user.username,
    type: user.type,
    initialSetupComplete: user.initialSetupComplete,
    anonymousDataCollection: user.anonymousDataCollection,

    workspaces: user.usersOnWorkspaces.map((uWorkspace) => ({
      ...uWorkspace.workspace,
      status: uWorkspace.status,
      role: uWorkspace.role,
    })),
  };
}
