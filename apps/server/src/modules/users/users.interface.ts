import {
  AGENT_OWNERSHIPS,
  AGENT_SCOPES,
  AgentOwnership,
  AgentScope,
  Invite,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NotificationPreferences,
  User,
  sanitizeNotificationPreferences,
} from '@vantikhq/types';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  ValidateBy,
} from 'class-validator';

/**
 * Only known categories, only known channels, only booleans. Anything else is
 * a client bug, and storing it would leave keys in the column nothing reads.
 */
function isNotificationPreferences(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.entries(value).every(
    ([category, forCategory]) =>
      (NOTIFICATION_CATEGORIES as readonly string[]).includes(category) &&
      !!forCategory &&
      typeof forCategory === 'object' &&
      !Array.isArray(forCategory) &&
      Object.entries(forCategory).every(
        ([channel, setting]) =>
          (NOTIFICATION_CHANNELS as readonly string[]).includes(channel) &&
          typeof setting === 'boolean',
      ),
  );
}

export class UserIdParams {
  @IsString()
  userId: string;
}

export class UpdateUserBody {
  @IsOptional()
  @IsString()
  fullname?: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsBoolean()
  hideEmail?: boolean;

  /**
   * A partial update: the categories and channels sent are merged over the
   * stored ones, so a single switch can be saved on its own.
   */
  @IsOptional()
  @ValidateBy({
    name: 'isNotificationPreferences',
    validator: {
      validate: isNotificationPreferences,
      defaultMessage: () =>
        `notificationPreferences must map ${NOTIFICATION_CATEGORIES.join(', ')} to { inApp?: boolean, email?: boolean }`,
    },
  })
  notificationPreferences?: NotificationPreferences;
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

export class ImpersonateBody {
  @IsString()
  key: string;

  @IsString()
  userId: string;
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
    hideEmail: user.hideEmail,
    notificationPreferences:
      sanitizeNotificationPreferences(user.notificationPreferences) ?? {},

    workspaces: user.usersOnWorkspaces.map((uWorkspace) => ({
      ...uWorkspace.workspace,
      status: uWorkspace.status,
      role: uWorkspace.role,
    })),
  };
}
