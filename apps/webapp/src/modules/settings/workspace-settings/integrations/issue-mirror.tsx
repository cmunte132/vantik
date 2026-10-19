import { Checkbox } from '@vantikhq/ui/components/checkbox';

import type { TeamType } from 'common/types';

import { useAllTeams } from 'hooks/teams';

/**
 * The teams whose issues one repository carries for agents.
 *
 * Off until someone ticks a team, because the mirror is readable by anyone who
 * can read the repository, and that is a decision about the repository as much
 * as about the team. The server refuses it for a member who is not an admin.
 * The caller shows its reason through `error`.
 */
export function IssueMirror({
  selected,
  isPending,
  error,
  onChange,
}: {
  selected: string[];
  isPending: boolean;
  error: string;
  onChange: (teamIds: string[]) => void;
}) {
  const teams: TeamType[] = useAllTeams();

  // A team that was deleted can stay in the stored list. The server drops it,
  // so the page leaves it out of the list that it sends and shows.
  const known = selected.filter((id) => teams.some((team) => team.id === id));

  const toggle = (teamId: string, on: boolean) =>
    onChange(on ? [...known, teamId] : known.filter((id) => id !== teamId));

  return (
    <div className="flex flex-col gap-1 pt-2">
      <div className="text-muted-foreground">
        Mirror these teams&apos; issues into{' '}
        <span className="font-mono">refs/vantik/issues</span>, for agents that
        can reach this repository but not Vantik. Anyone who can read the
        repository can read them.
      </div>
      <div className="flex flex-wrap gap-3">
        {teams.map((team) => (
          <label key={team.id} className="flex items-center gap-1.5">
            <Checkbox
              checked={known.includes(team.id)}
              disabled={isPending}
              onCheckedChange={(checked) => toggle(team.id, checked === true)}
            />
            {team.name}
          </label>
        ))}
      </div>
      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}
