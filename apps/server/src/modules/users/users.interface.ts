import {
  AGENT_OWNERSHIPS,
  AGENT_SCOPES,
  AgentOwnership,
  AgentScope,
  Invite,
  User,
} from '@vantikhq/types';
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
   * Who the agent belongs to. A personal agent is one person's tool — they
   * connect their own client with it and they retire it. A workspace agent is
   * a shared credential held by CI, a scheduled job or a shared runner, with
   * no owning user, which is why an admin rather than an owner retires it.
   *
   * Defaults to personal, so an existing caller that sends no ownership keeps
   * the behaviour it had when this was hardcoded.
   */
  @IsOptional()
  @IsIn(AGENT_OWNERSHIPS)
  ownership?: AgentOwnership;

  /**
   * What the agent may do. Omit for the default — read and write, but not
   * delete. Unknown values are rejected with a validation error, so only
   * scopes listed in AGENT_SCOPES are accepted.
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
