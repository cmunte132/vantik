import type { User } from './types';

import { RiRobot2Line } from '@remixicon/react';
import { AvatarText } from '@vantikhq/ui/components/avatar';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@vantikhq/ui/components/tooltip';
import { cn } from '@vantikhq/ui/lib/utils';

import { isAgentUser } from './user-util';

interface UserAvatarProps {
  user: User;
  showFull?: boolean;
  className?: string;
}

export function UserAvatar({
  user,
  showFull = false,
  className,
}: UserAvatarProps) {
  if (!user) {
    return null;
  }

  const isAgent = isAgentUser(user);

  // Attribution flows from userId, so an agent's edits already read as that
  // agent's. This is the part that says it was not a person: an icon where the
  // initials would be, spelled out in the tooltip.
  const mark = isAgent ? (
    <RiRobot2Line className="w-5 h-5 shrink-0 bg-background-3 rounded-sm p-[2px]" />
  ) : (
    <AvatarText text={user.fullname} className="w-5 h-5 text-[9px]" />
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn(className)}>
          {mark}

          {showFull && <> {user.fullname}</>}
        </div>
      </TooltipTrigger>
      <TooltipContent className="p-2">
        <div className="flex gap-2 items-center">
          {mark}

          {user.fullname}

          {isAgent && (
            <span className="text-muted-foreground text-xs">Agent</span>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
