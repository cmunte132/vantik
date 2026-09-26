import type {
  IntegrationAccount,
  TeamMapping,
  TeamMappingParams,
} from '@vantikhq/types';

import { RiDeleteBinLine } from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import { Input } from '@vantikhq/ui/components/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vantikhq/ui/components/select';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { SettingSection } from 'modules/settings/setting-section';

import type { TeamType, UsersOnWorkspaceType } from 'common/types';

import { useAllTeams } from 'hooks/teams';

import { useUpdateTeamMappingsMutation } from 'services/integration-account';

import { useContextStore } from 'store/global-context-provider';
import { UserContext } from 'store/user-context';

import { useIntegrationAccount } from './integration-util';

interface Repository {
  id: string;
  fullName: string;
}

interface TeamMappingsProps {
  account: IntegrationAccount;
  params: TeamMappingParams;
}

/**
 * Its own section, shown once the workspace account exists: the pairs are
 * saved on that account, so there is nothing to edit before it is connected.
 */
export const TeamMappingsSection = observer(
  ({
    integrationDefinitionId,
    params,
  }: {
    integrationDefinitionId: string;
    params: TeamMappingParams;
  }) => {
    const account = useIntegrationAccount(integrationDefinitionId);

    if (!account) {
      return null;
    }

    return (
      <SettingSection title="Team mappings" description={params.instruction}>
        <TeamMappings account={account} params={params} />
      </SettingSection>
    );
  },
);

/**
 * Which team each repository or address sends its work to.
 *
 * Each add and remove is saved at once, and the account comes back over the
 * socket, so the list below is always what the server holds. Only your own
 * teams can be picked, and a teammate's pair for a team you are not in shows
 * without a remove button: the server refuses either change, because a pair
 * decides where a team's issues are published.
 */
export const TeamMappings = observer(
  ({ account, params }: TeamMappingsProps) => {
    const { workspaceStore } = useContextStore();
    const currentUser = React.useContext(UserContext);
    const teams = useAllTeams();

    const settings = React.useMemo(
      () => parseSettings(account.settings),
      [account.settings],
    );
    const mappings: TeamMapping[] = settings.teamMappings ?? [];
    const repositories: Repository[] = settings.repositories ?? [];

    const myTeamIds = new Set<string>(
      workspaceStore.usersOnWorkspaces.find(
        (member: UsersOnWorkspaceType) => member.userId === currentUser.id,
      )?.teamIds ?? [],
    );
    const myTeams = teams.filter((team: TeamType) => myTeamIds.has(team.id));

    const [source, setSource] = React.useState('');
    const [teamId, setTeamId] = React.useState('');
    const [error, setError] = React.useState('');

    const { mutate: save, isPending: saving } = useUpdateTeamMappingsMutation({
      onSuccess: () => {
        setSource('');
        setTeamId('');
        setError('');
      },
      onError: (failure) =>
        setError(
          failure?.response?.data?.message ??
            'The server refused this change, and it gave no reason.',
        ),
    });

    const write = (teamMappings: TeamMapping[]) =>
      save({ integrationAccountId: account.id, teamMappings });

    const add = () => {
      if (!source.trim() || !teamId || saving) {
        return;
      }

      write([...mappings, { source: source.trim(), teamId }]);
    };

    const sourceName = (value: string) =>
      params.source === 'repository'
        ? (repositories.find((repository) => repository.id === value)
            ?.fullName ?? 'A repository no longer installed')
        : value;

    const teamName = (id: string) =>
      teams.find((team: TeamType) => team.id === id)?.name ??
      'A team you are not in';

    return (
      <div className="flex flex-col gap-3">
        <div className="rounded border bg-background-3">
          {mappings.map((mapping) => (
            <div
              key={`${mapping.source}:${mapping.teamId}`}
              className="flex items-center gap-2 border-b border-border p-3 last:border-b-0"
            >
              <div className="min-w-0 grow truncate">
                <span
                  className={
                    params.source === 'address' ? 'font-mono' : 'font-medium'
                  }
                >
                  {sourceName(mapping.source)}
                </span>
                <span className="mx-2 text-muted-foreground">→</span>
                <span>{teamName(mapping.teamId)}</span>
              </div>
              {myTeamIds.has(mapping.teamId) && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Unpair ${sourceName(mapping.source)}`}
                  disabled={saving}
                  onClick={() =>
                    write(mappings.filter((other) => other !== mapping))
                  }
                >
                  <RiDeleteBinLine size={14} />
                </Button>
              )}
            </div>
          ))}

          {mappings.length === 0 && (
            <div className="p-3 text-muted-foreground">
              No team is paired yet, so nothing is routed.
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex gap-2">
            {params.source === 'repository' ? (
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a repository" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {repositories.map((repository) => (
                      <SelectItem key={repository.id} value={repository.id}>
                        {repository.fullName}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={source}
                placeholder="support"
                className="font-mono"
                onChange={(event) => setSource(event.currentTarget.value)}
                onKeyDown={(event) => event.key === 'Enter' && add()}
              />
            )}

            <Select value={teamId} onValueChange={setTeamId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a team" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {myTeams.map((team: TeamType) => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>

            <Button
              variant="secondary"
              onClick={add}
              isLoading={saving}
              disabled={!source.trim() || !teamId}
            >
              Pair
            </Button>
          </div>
          {error && <p className="text-destructive">{error}</p>}
        </div>
      </div>
    );
  },
);

/** The synced store keeps an account's settings as a JSON string. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseSettings(settings: unknown): Record<string, any> {
  if (typeof settings !== 'string') {
    return (settings ?? {}) as Record<string, unknown>;
  }

  try {
    return JSON.parse(settings) ?? {};
  } catch {
    return {};
  }
}
