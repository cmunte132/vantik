import { RiAddLine, RiDeleteBinLine, RiMoreLine } from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vantikhq/ui/components/dropdown-menu';
import { useToast } from '@vantikhq/ui/components/use-toast';
import React from 'react';

import {
  useAddTeamMemberMutation,
  useRemoveTeamMemberMutation,
} from 'services/team';

import { UserContext } from 'store/user-context';

interface TeamOptionsDropdownProps {
  team: {
    id: string;
    name: string;
    identifier: string;
    createdAt: string;
  };
  teamAccessList: string[];
}

export function TeamOptionsDropdown({
  team,
  teamAccessList,
}: TeamOptionsDropdownProps) {
  const { toast } = useToast();
  const currentUser = React.useContext(UserContext);
  const { mutate: removeMember } = useRemoveTeamMemberMutation({
    onSuccess: () => {
      toast({
        title: 'Team',
        description: 'Successfully left team',
      });
    },
    onError: (err: string) => {
      toast({
        variant: 'destructive',
        title: 'Error!',
        description: err,
      });
    },
  });
  const { mutate: addTeamMember } = useAddTeamMemberMutation({
    onSuccess: () => {
      toast({
        title: 'Team',
        description: 'Joined team successfully',
      });
    },
  });

  const hasTeamAccess = teamAccessList.includes(team.id);

  return (
    <div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="link"
            size="sm"
            onClick={(e) => {
              e.preventDefault();
            }}
          >
            <RiMoreLine size={16} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            {!hasTeamAccess && (
              <DropdownMenuItem
                onClick={() =>
                  addTeamMember({
                    userId: currentUser.id,
                    teamId: team.id,
                  })
                }
              >
                <div className="flex items-center gap-1">
                  <RiAddLine size={16} /> Join team
                </div>
              </DropdownMenuItem>
            )}
            {hasTeamAccess && (
              <DropdownMenuItem
                onClick={() => {
                  removeMember({
                    userId: currentUser.id,
                    teamId: team.id,
                  });
                }}
              >
                <div className="flex items-center gap-1">
                  <RiDeleteBinLine size={16} /> Leave team
                </div>
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
