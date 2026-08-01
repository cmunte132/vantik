import { RiAddLine, RiCheckLine, RiDeleteBinLine } from '@remixicon/react';
import { useQuery } from '@tanstack/react-query';
import { getModuleRepos } from '@vantikhq/services';
import { Badge } from '@vantikhq/ui/components/badge';
import { Button } from '@vantikhq/ui/components/button';
import {
  Command,
  CommandGroup,
  CommandInput,
} from '@vantikhq/ui/components/command';
import { Input } from '@vantikhq/ui/components/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@vantikhq/ui/components/popover';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import NextLink from 'next/link';
import { useRouter } from 'next/router';
import * as React from 'react';

import { DropdownItem } from 'modules/issues/components/issue-metadata/dropdown-item';

import type { IntegrationAccountType } from 'common/types';
import { workspaceHref } from 'common/workspace-href';

import { useScope } from 'hooks';

import { useGetLocalRepositoryFolders } from 'services/local-repo';
import {
  useCreateModuleRepoMutation,
  useDeleteModuleRepoMutation,
  useUpdateModuleRepoMutation,
} from 'services/product-axis';

import { useContextStore } from 'store/global-context-provider';

interface ConnectableRepo {
  /** The id the provider gave it. A webhook arrives carrying this. */
  externalRepoId: string;
  fullName: string;
  integrationAccountId: string;

  /**
   * Where the checkout is, when the repository is on this machine. Two local
   * repositories can share a directory name, and the path is what tells them
   * apart. A repository from a remote source has no path.
   */
  path?: string;
}

/**
 * Where a module's code lives.
 *
 * The repositories on offer come from a connected source-control account and
 * from nowhere else. There used to be a free text field here, which asked a
 * person to type a name that nothing would ever check and implied a connection
 * that did not exist.
 *
 * Connecting one records that this repository, or these paths inside it, hold
 * the code of this module. Two things read that record: this page, and the
 * webhook that decides which module a pull request changed.
 */
export const Repositories = observer(({ moduleId }: { moduleId: string }) => {
  const { integrationAccountsStore } = useContextStore();
  const {
    query: { workspaceSlug },
  } = useRouter();

  const { data: repos = [], refetch } = useQuery({
    queryKey: ['module-repos', moduleId],
    queryFn: () => getModuleRepos({ moduleId }),
  });

  const { mutate: createRepo } = useCreateModuleRepoMutation({
    onSuccess: () => refetch(),
  });
  const { mutate: deleteRepo } = useDeleteModuleRepoMutation({
    onSuccess: () => refetch(),
  });

  const available = React.useMemo(
    () => connectableRepos(integrationAccountsStore.integrationAccounts),
    [integrationAccountsStore.integrationAccounts],
  );

  const connectedIds = new Set(repos.map((repo) => repo.externalRepoId));
  const unconnected = available.filter(
    (repo) => !connectedIds.has(repo.externalRepoId),
  );

  // A `ModuleRepo` row holds the identifier and the name, and no path. The
  // path of a local repository lives on the account, so the row reads it back
  // from there.
  const pathById = new Map(
    available.map((repo) => [repo.externalRepoId, repo.path]),
  );

  return (
    <>
      {repos.map((repo) => (
        <div
          key={repo.id}
          className="flex items-center gap-2 border-b border-border px-4 py-2"
        >
          <div className="flex-1 min-w-0">
            <div className="truncate">{repo.fullName}</div>
            {pathById.get(repo.externalRepoId) && (
              <div className="text-muted-foreground font-mono truncate">
                {pathById.get(repo.externalRepoId)}
              </div>
            )}
            {/*
              The badge beside this names the scope when there is one folder,
              and says "whole repository" when there is none. Only a list of
              several needs spelling out here.
            */}
            {repo.pathPrefixes.length > 1 && (
              <div className="text-muted-foreground font-mono truncate">
                {repo.pathPrefixes.join('  ·  ')}
              </div>
            )}
          </div>

          <ScopeEditor
            moduleId={moduleId}
            moduleRepoId={repo.id}
            prefixes={repo.pathPrefixes}
            localRepositoryId={
              pathById.get(repo.externalRepoId)
                ? repo.externalRepoId
                : undefined
            }
            onSaved={() => refetch()}
          />

          <Button
            variant="ghost"
            size="sm"
            aria-label={`Disconnect ${repo.fullName}`}
            onClick={() => deleteRepo({ moduleId, moduleRepoId: repo.id })}
          >
            <RiDeleteBinLine size={14} />
          </Button>
        </div>
      ))}

      {/*
        Nothing to offer and nothing connected. Say why, and say where to go.
        An empty picker here reads as a broken control rather than as a missing
        integration.
      */}
      {available.length === 0 ? (
        <div className="px-4 py-3 text-muted-foreground">
          This workspace has no repositories yet. Add one in{' '}
          <NextLink
            href={workspaceHref(workspaceSlug, 'settings', 'integrations')}
            className="underline"
          >
            Settings → Integrations
          </NextLink>
          , either as a directory on this machine or through a source control
          account, and it appears here.
        </div>
      ) : (
        <div className="px-4 py-2">
          <RepoPicker
            repos={unconnected}
            onSelect={(repo) =>
              createRepo({
                moduleId,
                externalRepoId: repo.externalRepoId,
                fullName: repo.fullName,
                integrationAccountId: repo.integrationAccountId,
              })
            }
          />
        </div>
      )}
    </>
  );
});

/**
 * The repositories that a connected account can offer.
 *
 * `settings` is a JSON string on the client. A malformed one is an integration
 * problem and not a reason for this page to fail, so it is skipped.
 */
function connectableRepos(
  accounts: IntegrationAccountType[],
): ConnectableRepo[] {
  const found: ConnectableRepo[] = [];

  for (const account of accounts) {
    if (account.personal || !account.settings) {
      continue;
    }

    let settings: {
      repositories?: Array<{ id: string; fullName: string; path?: string }>;
    };

    try {
      settings =
        typeof account.settings === 'string'
          ? JSON.parse(account.settings)
          : account.settings;
    } catch {
      continue;
    }

    for (const repo of settings?.repositories ?? []) {
      found.push({
        externalRepoId: String(repo.id),
        fullName: repo.fullName,
        integrationAccountId: account.id,
        path: repo.path,
      });
    }
  }

  return found;
}

function RepoPicker({
  repos,
  onSelect,
}: {
  repos: ConnectableRepo[];
  onSelect: (repo: ConnectableRepo) => void;
}) {
  const [open, setOpen] = React.useState(false);

  if (repos.length === 0) {
    return (
      <span className="text-muted-foreground">
        Every repository this workspace can see is already connected here.
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="sm" className="gap-1">
          <RiAddLine size={14} />
          Connect a repository
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <RepoPickerContent
          repos={repos}
          onSelect={(repo) => {
            onSelect(repo);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function RepoPickerContent({
  repos,
  onSelect,
}: {
  repos: ConnectableRepo[];
  onSelect: (repo: ConnectableRepo) => void;
}) {
  useScope('command');

  return (
    <Command>
      <CommandInput placeholder="Find a repository..." autoFocus />
      <CommandGroup>
        {repos.map((repo, index) => (
          <DropdownItem
            key={repo.externalRepoId}
            id={repo.externalRepoId}
            value={`${repo.fullName} ${repo.path ?? ''}`}
            index={index}
            onSelect={() => onSelect(repo)}
          >
            <span className="flex min-w-0 flex-col">
              <span className="font-mono">{repo.fullName}</span>
              {repo.path && (
                <span className="truncate font-mono text-muted-foreground">
                  {repo.path}
                </span>
              )}
            </span>
          </DropdownItem>
        ))}
      </CommandGroup>
    </Command>
  );
}

/**
 * Which part of one repository belongs to this module.
 *
 * Separate from the connection, because they are two different decisions.
 * Which repository holds the code is nearly always obvious. Which part of it
 * is the question that a monorepo asks and a service repository does not.
 *
 * The choice belongs to this module and to no other. Two modules can connect
 * the same repository, and each one keeps its own folders here.
 *
 * The server reads the folders from the disk when the repository is on this
 * machine. A repository from a remote source has none to offer yet, and the
 * field at the end of the list is what that person uses.
 */
function ScopeEditor({
  moduleId,
  moduleRepoId,
  prefixes,
  localRepositoryId,
  onSaved,
}: {
  moduleId: string;
  moduleRepoId: string;
  prefixes: string[];
  localRepositoryId?: string;
  onSaved: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<string[]>(prefixes);
  const [typed, setTyped] = React.useState('');

  const { data: folders = [], isLoading } = useGetLocalRepositoryFolders(
    localRepositoryId,
    open,
  );

  const { mutate: updateRepo } = useUpdateModuleRepoMutation({
    onSuccess: onSaved,
  });

  // The row above is the truth until somebody opens this. A save on another
  // repository, or a change from another tab, arrives that way.
  const committed = prefixes.join(' ');

  React.useEffect(() => {
    setSelected(prefixes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committed]);

  const toggle = (path: string) =>
    setSelected((current) =>
      current.includes(path)
        ? current.filter((entry) => entry !== path)
        : [...current, path],
    );

  // A typed path is one that discovery did not find, so it goes at the end of
  // the list and stays visible there.
  const extra = selected.filter(
    (path) => !folders.some((folder) => folder.path === path),
  );

  const save = () => {
    const typedPaths = typed.split(/[\s,]+/).filter(Boolean);

    updateRepo({
      moduleId,
      moduleRepoId,
      pathPrefixes: [...new Set([...selected, ...typedPaths])],
    });
    setTyped('');
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm">
          {prefixes.length === 0 ? (
            <Badge variant="outline">whole repository</Badge>
          ) : (
            <Badge variant="secondary">
              {prefixes.length === 1
                ? prefixes[0].replace(/\/$/, '')
                : `${prefixes.length} folders`}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0" align="end">
        <div className="border-b border-border p-3">
          <p className="text-muted-foreground">
            Which part of this repository holds the code of this module.
          </p>
        </div>

        <div className="max-h-72 overflow-y-auto">
          {/*
            The whole repository is a choice and not the absence of one. A
            service repository stops here, and a monorepo goes on to the
            folders below.
          */}
          <ScopeRow
            checked={selected.length === 0}
            onSelect={() => setSelected([])}
            label="The whole repository"
          />

          {isLoading && (
            <div className="px-3 py-2 text-muted-foreground">
              Reading the folders...
            </div>
          )}

          {folders.map((folder) => (
            <ScopeRow
              key={folder.path}
              checked={selected.includes(folder.path)}
              onSelect={() => toggle(folder.path)}
              label={folder.path}
              mono
              indented={folder.depth > 1}
              hint={folder.isProject ? 'project' : undefined}
            />
          ))}

          {extra.map((path) => (
            <ScopeRow
              key={path}
              checked
              onSelect={() => toggle(path)}
              label={path}
              mono
            />
          ))}

          {!isLoading && folders.length === 0 && (
            <div className="px-3 py-2 text-muted-foreground">
              {localRepositoryId
                ? 'This repository keeps its code at the root, so there is no folder to pick.'
                : 'This repository is not on this machine, so its folders are unknown. Type a path below.'}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border p-3">
          <Input
            value={typed}
            placeholder="another/path/"
            className="font-mono"
            onChange={(event) => setTyped(event.currentTarget.value)}
            onKeyDown={(event) => event.key === 'Enter' && save()}
          />
          <Button variant="secondary" size="sm" onClick={save}>
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ScopeRow({
  checked,
  onSelect,
  label,
  hint,
  mono,
  indented,
}: {
  checked: boolean;
  onSelect: () => void;
  label: string;
  hint?: string;
  mono?: boolean;
  indented?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-grayAlpha-100',
        indented && 'pl-7',
      )}
    >
      {/*
        A drawn box and not the Checkbox component. That component renders a
        button of its own, and a button inside a button is invalid HTML that
        React reports at hydration.
      */}
      <span
        aria-hidden
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border-1 border-border',
          checked && 'border-primary bg-primary text-primary-foreground',
        )}
      >
        {checked && <RiCheckLine size={12} />}
      </span>
      <span className={cn('flex-1 truncate', mono && 'font-mono')}>
        {label}
      </span>
      {hint && <Badge variant="outline">{hint}</Badge>}
    </button>
  );
}
