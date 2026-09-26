import { RiTeamLine } from '@remixicon/react';
import { Checkbox } from '@vantikhq/ui/components/checkbox';
import { CommandGroup } from '@vantikhq/ui/components/command';

import { DropdownItem } from 'modules/issues/components/issue-metadata/dropdown-item';

import type { TeamType } from 'common/types';

import { useAllTeams } from 'hooks/teams';

interface TeamsDropdownContentProps {
  onChange?: (id: string | string[]) => void;
  onClose: () => void;
  multiple?: boolean;
  value: string | string[];
}

export function TeamsDropdownContent({
  onChange,
  onClose,
  multiple = false,
  value,
}: TeamsDropdownContentProps) {
  const teams = useAllTeams();

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

  return (
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
  );
}
