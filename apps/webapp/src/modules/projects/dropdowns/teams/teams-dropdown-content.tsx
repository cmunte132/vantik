import { RiTeamLine } from '@remixicon/react';
import { Checkbox } from '@vantikhq/ui/components/checkbox';
import { CommandGroup, CommandList } from '@vantikhq/ui/components/command';

import { DropdownItem } from 'modules/issues/components/issue-metadata/dropdown-item';

import type { TeamType } from 'common/types';

import { useAllTeams } from 'hooks/teams';

interface TeamsDropdownContentProps {
  onChange?: (id: string | string[]) => void;
  onClose: () => void;
  multiple?: boolean;
  value: string | string[];
  /** What is typed in the picker's box. Only teams that match it are listed. */
  search?: string;
}

export function TeamsDropdownContent({
  onChange,
  onClose,
  multiple = false,
  value,
  search = '',
}: TeamsDropdownContentProps) {
  const teams = useAllTeams().filter((team: TeamType) =>
    `${team.name} ${team.identifier}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );

  const onValueChange = (checked: boolean, id: string) => {
    if (checked && !value.includes(id)) {
      onChange && onChange([...value, id]);
    }

    if (!checked && value.includes(id)) {
      const newIds = [...value];
      const indexToDelete = newIds.indexOf(id);

      newIds.splice(indexToDelete, 1);
      onChange && onChange(newIds);
    }
  };

  // The list scrolls. A workspace can have more teams than fit on the screen,
  // and those past its edge could not be reached.
  return (
    <CommandList className="max-h-72">
      <CommandGroup>
        {teams.map((team: TeamType, index: number) => {
          return (
            <DropdownItem
              key={team.name}
              id={team.id}
              value={team.name}
              index={index + 1}
              // The row picks the team, so Enter on a highlighted row works as a
              // click does. The checkbox only shows the state: were it to toggle
              // too, a click on it would reach the row and undo itself.
              onSelect={() => {
                if (multiple) {
                  onValueChange(!value.includes(team.id), team.id);
                } else {
                  onChange && onChange(team.id);
                  onClose();
                }
              }}
            >
              <div className="flex gap-2 w-full items-center">
                {multiple && (
                  <Checkbox
                    checked={value.includes(team.id)}
                    tabIndex={-1}
                    className="pointer-events-none"
                  />
                )}
                <label className="flex grow items-center">
                  <RiTeamLine size={18} className="mr-2" />
                  <span className="grow">{team.name}</span>
                </label>
              </div>
            </DropdownItem>
          );
        })}
      </CommandGroup>
    </CommandList>
  );
}
