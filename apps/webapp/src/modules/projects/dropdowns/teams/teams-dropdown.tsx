// import { WORKFLOW_CATEGORY_ICONS } from 'common/types'

// import type { WorkflowType } from 'common/types'

import { Button } from '@vantikhq/ui/components/button';
import { Command, CommandInput } from '@vantikhq/ui/components/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@vantikhq/ui/components/popover';
import { TeamIcon } from '@vantikhq/ui/components/team-icon';
import { useToast } from '@vantikhq/ui/components/use-toast';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import type { TeamType } from 'common/types';

import { useContextStore } from 'store/global-context-provider';

import { TeamsDropdownContent } from './teams-dropdown-content';
import { ProjectDropdownVariant } from '../status';

interface TeamsProps {
  value?: string[];
  onChange?: (teams: string[]) => void;
  variant?: ProjectDropdownVariant;
}

export const TeamsDropdown = observer(
  ({ value, onChange, variant }: TeamsProps) => {
    const [open, setOpen] = React.useState(false);
    const { teamsStore } = useContextStore();
    const { toast } = useToast();

    const change = (teams: string[]) => {
      if (teams.length === 0) {
        toast({
          title: 'Error!',
          description: 'You need atleast one team',
        });
        return;
      }

      onChange && onChange(teams);
    };

    function getTrigger() {
      // A team id that no longer resolves is dropped rather than rendered.
      // A team can be deleted while a project still names it, and the trigger
      // reads `name` and `preferences` off whatever it is handed.
      const teams = (value ?? [])
        .map((team: string) => teamsStore.getTeamWithId(team))
        .filter(Boolean) as TeamType[];

      // A project need not name a team. The dialog asks for one and this
      // dropdown refuses to remove the last one, but a project created over
      // the API carries none, and the server is content with that: a project
      // belongs to its workspace, and no team owns it. So the trigger says so
      // and stays clickable, instead of reading a name off `teams[0]`.
      if (teams.length === 0) {
        return (
          <Button
            variant="link"
            role="combobox"
            aria-expanded={open}
            className="flex items-center px-0 shadow-none justify-between focus-visible:ring-1 focus-visible:border-primary text-muted-foreground"
          >
            No teams
          </Button>
        );
      }

      if (variant === ProjectDropdownVariant.LINK) {
        return (
          <Button
            variant="link"
            role="combobox"
            aria-expanded={open}
            className="flex items-center px-0 shadow-none justify-between focus-visible:ring-1 focus-visible:border-primary"
          >
            <TeamIcon
              preferences={teams[0].preferences}
              name={teams[0].name}
              className="mr-1"
            />
            {teams.length > 1
              ? `${teams.map((team) => team.identifier).join(', ')}`
              : `${teams[0].name}`}
          </Button>
        );
      }

      return (
        <Button
          variant="link"
          role="combobox"
          aria-expanded={open}
          className="flex items-center gap-1 justify-between shadow-none focus-visible:ring-1 focus-visible:border-primary "
        >
          <TeamIcon preferences={teams[0].preferences} name={teams[0].name} />

          {teams.length > 1
            ? `${teams.map((team) => team.identifier).join(', ')}`
            : `${teams[0].name}`}
        </Button>
      );
    }

    return (
      <div>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="link"
              role="combobox"
              size="sm"
              aria-expanded={open}
              className="flex items-center p-0 justify-between focus-visible:ring-1 focus-visible:border-primary "
            >
              {getTrigger()}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-0" align="start">
            <Command shouldFilter={false}>
              <CommandInput placeholder="Set status..." autoFocus />
              <TeamsDropdownContent
                onChange={change}
                onClose={() => setOpen(false)}
                value={value}
                multiple
              />
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    );
  },
);
