import { RiRobot2Line } from '@remixicon/react';
import { RoleEnum, UserTypeEnum } from '@vantikhq/types';
import { AvatarText } from '@vantikhq/ui/components/avatar';

import type { User } from 'common/types';

import { getBotIcon } from './icon-utils';

export function getUserFromUsersData(usersData: User[], userId: string) {
  return usersData.find((userData: User) => userData.id === userId);
}

/**
 * Whether this account is an LLM agent rather than a person.
 *
 * `type` is the account's own answer and the one to trust, but it arrived after
 * agents did, and role is what older payloads and the sync cache carry. Reading
 * both means an agent still reads as an agent through either.
 *
 * An AGENT is not a BOT: BOT is the actions feature's automation, badged with
 * its own integration icon.
 */
export function isAgentUser(user?: User) {
  return user?.type === UserTypeEnum.Agent || user?.role === RoleEnum.AGENT;
}

export function getUserIcon(user: User) {
  if (user && user.role === RoleEnum.BOT && user.image) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Component = getBotIcon(user.image as any);

    return (
      <Component className="text-[9px] mr-2 h-5 w-5 bg-background-3 rounded-sm p-[2px]" />
    );
  }

  // Agents get an icon rather than initials: an assignee list should read at a
  // glance as people plus machines, not as more colleagues.
  if (isAgentUser(user)) {
    return (
      <RiRobot2Line className="text-[9px] mr-2 h-5 w-5 bg-background-3 rounded-sm p-[2px]" />
    );
  }

  return <AvatarText text={user?.fullname} className="text-[9px] mr-2" />;
}
