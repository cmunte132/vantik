import type { GitRemoteConnection, GitRemoteKind } from '@vantikhq/types';

import { RiAddLine, RiDeleteBinLine } from '@remixicon/react';
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vantikhq/ui/components/select';
import * as React from 'react';

import { DropdownItem } from 'modules/issues/components/issue-metadata/dropdown-item';

import { useScope } from 'hooks';

import {
  useAddGitRemoteRepositoryMutation,
  useConnectGitRemoteMutation,
  useDisconnectGitRemoteMutation,
  useGetAvailableGitRemoteRepositories,
  useGetGitRemotes,
  useRemoveGitRemoteRepositoryMutation,
} from 'services/git-remote';
import { errorMessage } from 'services/utils/mutation';

const KIND_LABELS: Record<GitRemoteKind, string> = {
  forgejo: 'Forgejo',
  gitea: 'Gitea',
  gitlab: 'GitLab',
  generic: 'Other git host',
};

/**
 * The git hosts that this workspace connected.
 *
 * Each host is one connection with one token. The server checks the token
 * against the API of the host before it keeps it. It also runs `git ls-remote`
 * on each repository before it adds the repository, so a repository in this
 * list is one that the server can fetch.
 */
export function GitRemotes({ instruction }: { instruction?: string }) {
  const { data: connections = [], isLoading } = useGetGitRemotes();

  return (
    <div className="flex flex-col gap-4">
      {connections.map((connection) => (
        <Connection key={connection.id} connection={connection} />
      ))}

      {!isLoading && connections.length === 0 && (
        <div className="rounded border bg-background-3 p-3 text-muted-foreground">
          This workspace has no git host yet.
        </div>
      )}

      <ConnectForm instruction={instruction} />
    </div>
  );
}

function Connection({ connection }: { connection: GitRemoteConnection }) {
  const [error, setError] = React.useState('');
  const [editing, setEditing] = React.useState(false);

  const { mutate: disconnect } = useDisconnectGitRemoteMutation({
    onError: setError,
  });
  const { mutate: removeRepository } = useRemoveGitRemoteRepositoryMutation({
    onError: setError,
  });

  return (
    <div className="rounded border bg-background-3">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <div className="min-w-0 grow">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono">{connection.baseUrl}</span>
            <Badge variant="secondary">{KIND_LABELS[connection.kind]}</Badge>
          </div>
          <div className="text-muted-foreground">
            {connection.hasToken
              ? `As ${connection.username}, with token ${connection.tokenHint ?? ''}`
              : 'No token. The server can fetch public repositories, but it cannot push.'}
            {connection.hasToken && connection.author && (
              <> · Commits as {connection.author}</>
            )}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setEditing(!editing)}>
          {connection.hasToken ? 'Change token' : 'Add token'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Disconnect ${connection.baseUrl}`}
          onClick={() => disconnect({ connectionId: connection.id })}
        >
          <RiDeleteBinLine size={14} />
        </Button>
      </div>

      {editing && (
        <div className="border-b border-border p-3">
          <TokenForm connection={connection} onDone={() => setEditing(false)} />
        </div>
      )}

      {connection.repositories.map((repository) => (
        <div
          key={repository.id}
          className="flex items-center gap-2 border-b border-border px-3 py-2"
        >
          <div className="min-w-0 grow">
            <div className="font-mono">{repository.fullName}</div>
            <div className="truncate text-muted-foreground">
              {repository.defaultBranch
                ? `Default branch ${repository.defaultBranch}`
                : repository.cloneUrl}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove ${repository.fullName}`}
            onClick={() =>
              removeRepository({
                connectionId: connection.id,
                repositoryId: repository.id,
              })
            }
          >
            <RiDeleteBinLine size={14} />
          </Button>
        </div>
      ))}

      <div className="p-3">
        {connection.kind === 'generic' ? (
          <CloneUrlForm connection={connection} />
        ) : (
          <AddRepository connection={connection} />
        )}
        {error && <p className="mt-1 text-destructive">{error}</p>}
      </div>
    </div>
  );
}

function AddRepository({ connection }: { connection: GitRemoteConnection }) {
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState('');

  const {
    data: available = [],
    isFetching,
    error: listError,
  } = useGetAvailableGitRemoteRepositories(connection.id, open);

  const { mutate: add, isPending } = useAddGitRemoteRepositoryMutation({
    onSuccess: () => setError(''),
    onError: setError,
  });

  const offered = available.filter((repo) => !repo.added);

  return (
    <div className="flex flex-col gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="secondary"
            size="sm"
            className="gap-1 self-start"
            isLoading={isPending}
          >
            <RiAddLine size={14} />
            Add a repository
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          {isFetching ? (
            <div className="p-3 text-muted-foreground">
              Reading the repositories on {connection.baseUrl}...
            </div>
          ) : listError ? (
            <div className="p-3 text-destructive">
              {errorMessage(
                listError,
                'The server cannot list the repositories on this host.',
              )}
            </div>
          ) : offered.length === 0 ? (
            <div className="p-3 text-muted-foreground">
              This connection has every repository that the host offers.
            </div>
          ) : (
            <AvailableList
              repos={offered}
              onSelect={(fullName) => {
                setOpen(false);
                setError('');
                add({ connectionId: connection.id, fullName });
              }}
            />
          )}
        </PopoverContent>
      </Popover>
      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}

function AvailableList({
  repos,
  onSelect,
}: {
  repos: Array<{ id: string; fullName: string; private: boolean }>;
  onSelect: (fullName: string) => void;
}) {
  useScope('command');

  return (
    <Command>
      <CommandInput placeholder="Find a repository..." autoFocus />
      <CommandGroup>
        {repos.map((repo, index) => (
          <DropdownItem
            key={repo.id}
            id={repo.id}
            value={repo.fullName}
            index={index}
            onSelect={() => onSelect(repo.fullName)}
          >
            <span className="flex w-full items-center justify-between gap-2">
              <span className="truncate font-mono">{repo.fullName}</span>
              {repo.private && (
                <span className="text-muted-foreground">private</span>
              )}
            </span>
          </DropdownItem>
        ))}
      </CommandGroup>
    </Command>
  );
}

function CloneUrlForm({ connection }: { connection: GitRemoteConnection }) {
  const [cloneUrl, setCloneUrl] = React.useState('');
  const [error, setError] = React.useState('');

  const { mutate: add, isPending } = useAddGitRemoteRepositoryMutation({
    onSuccess: () => {
      setCloneUrl('');
      setError('');
    },
    onError: setError,
  });

  const submit = () => {
    if (!cloneUrl.trim() || isPending) {
      return;
    }

    add({ connectionId: connection.id, cloneUrl: cloneUrl.trim() });
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <Input
          value={cloneUrl}
          placeholder={`${connection.baseUrl}/owner/name.git`}
          className="font-mono"
          onChange={(event) => setCloneUrl(event.currentTarget.value)}
          onKeyDown={(event) => event.key === 'Enter' && submit()}
        />
        <Button variant="secondary" onClick={submit} isLoading={isPending}>
          Add
        </Button>
      </div>
      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}

function TokenForm({
  connection,
  onDone,
}: {
  connection: GitRemoteConnection;
  onDone: () => void;
}) {
  const [token, setToken] = React.useState('');
  const [error, setError] = React.useState('');

  const { mutate: connect, isPending } = useConnectGitRemoteMutation({
    onSuccess: onDone,
    onError: setError,
  });

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <Input
          autoFocus
          type="password"
          value={token}
          placeholder="Access token"
          onChange={(event) => setToken(event.currentTarget.value)}
        />
        <Button
          variant="secondary"
          isLoading={isPending}
          disabled={!token.trim()}
          onClick={() =>
            connect({
              kind: connection.kind,
              baseUrl: connection.baseUrl,
              token: token.trim(),
            })
          }
        >
          Save
        </Button>
      </div>
      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}

function ConnectForm({ instruction }: { instruction?: string }) {
  const [kind, setKind] = React.useState<GitRemoteKind>('forgejo');
  const [baseUrl, setBaseUrl] = React.useState('');
  const [username, setUsername] = React.useState('');
  const [token, setToken] = React.useState('');
  const [error, setError] = React.useState('');

  const { mutate: connect, isPending } = useConnectGitRemoteMutation({
    onSuccess: () => {
      setBaseUrl('');
      setUsername('');
      setToken('');
      setError('');
    },
    onError: setError,
  });

  const submit = () => {
    if (!baseUrl.trim() || isPending) {
      return;
    }

    setError('');
    connect({
      kind,
      baseUrl: baseUrl.trim(),
      username: username.trim() || undefined,
      token: token.trim() || undefined,
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground">
        {instruction ??
          'Connect a Forgejo, Gitea or GitLab host, or any git host that serves HTTP or HTTPS.'}{' '}
        Use a token that belongs to a bot account, not to a person: on Forgejo
        or Gitea, a user such as vantik-bot in a team with write access to the
        repositories; on GitLab, a project or group access token. Commits and
        pull requests then name the bot.
      </p>
      <div className="flex gap-2">
        <div className="w-44 shrink-0">
          <Select
            value={kind}
            onValueChange={(value) => setKind(value as GitRemoteKind)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {(Object.keys(KIND_LABELS) as GitRemoteKind[]).map((value) => (
                  <SelectItem key={value} value={value}>
                    {KIND_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <Input
          value={baseUrl}
          placeholder="https://forgejo.example.com"
          className="font-mono"
          onChange={(event) => setBaseUrl(event.currentTarget.value)}
        />
      </div>
      <div className="flex gap-2">
        <Input
          value={username}
          placeholder={
            kind === 'generic' ? 'User name' : 'User name (read from the token)'
          }
          className="w-44 shrink-0"
          onChange={(event) => setUsername(event.currentTarget.value)}
        />
        <Input
          type="password"
          value={token}
          placeholder="Access token"
          onChange={(event) => setToken(event.currentTarget.value)}
          onKeyDown={(event) => event.key === 'Enter' && submit()}
        />
        <Button variant="secondary" onClick={submit} isLoading={isPending}>
          Connect
        </Button>
      </div>
      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}
