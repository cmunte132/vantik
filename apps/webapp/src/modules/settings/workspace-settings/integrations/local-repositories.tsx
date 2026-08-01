import { RiDeleteBinLine } from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import { Input } from '@vantikhq/ui/components/input';
import * as React from 'react';

import {
  useAddLocalRepositoryMutation,
  useGetLocalRepositories,
  useRemoveLocalRepositoryMutation,
} from 'services/local-repo';

/**
 * The directories that this workspace treats as repositories.
 *
 * There is no account to authorise here. A local repository is a directory on
 * the machine that runs the server, so this panel takes a path in place of a
 * Connect button.
 *
 * The server checks each path before it writes anything. It refuses a relative
 * path, a path that is not there, and a directory that has no `.git`. The
 * message from the server appears below the field, because the person who
 * typed the path is the person who can correct it.
 */
export function LocalRepositories({ instruction }: { instruction?: string }) {
  const [path, setPath] = React.useState('');
  const [error, setError] = React.useState('');

  const {
    data: repositories = [],
    refetch,
    isLoading,
  } = useGetLocalRepositories();

  const { mutate: addRepository, isPending: adding } =
    useAddLocalRepositoryMutation({
      onSuccess: () => {
        setPath('');
        setError('');
        refetch();
      },
      onError: (failure) =>
        setError(
          failure?.response?.data?.message ??
            'The server refused this path, and it gave no reason.',
        ),
    });

  const { mutate: removeRepository } = useRemoveLocalRepositoryMutation({
    onSuccess: () => refetch(),
  });

  const submit = () => {
    if (!path.trim() || adding) {
      return;
    }

    setError('');
    addRepository({ path: path.trim() });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded border bg-background-3">
        {repositories.map((repository) => (
          <div
            key={repository.id}
            className="flex items-center gap-2 border-b border-border p-3 last:border-b-0"
          >
            <div className="min-w-0 grow">
              <div className="font-medium">{repository.fullName}</div>
              <div className="truncate font-mono text-muted-foreground">
                {repository.path}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Remove ${repository.fullName}`}
              onClick={() => removeRepository({ repositoryId: repository.id })}
            >
              <RiDeleteBinLine size={14} />
            </Button>
          </div>
        ))}

        {!isLoading && repositories.length === 0 && (
          <div className="p-3 text-muted-foreground">
            This workspace has no local repository yet.
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground">
          {instruction ??
            'Give the absolute path of a git repository on the machine that runs this server.'}
        </p>
        <div className="flex gap-2">
          <Input
            value={path}
            placeholder="/Users/you/Code/your-project"
            className="font-mono"
            onChange={(event) => setPath(event.currentTarget.value)}
            onKeyDown={(event) => event.key === 'Enter' && submit()}
          />
          <Button variant="secondary" onClick={submit} isLoading={adding}>
            Add
          </Button>
        </div>
        {error && <p className="text-destructive">{error}</p>}
      </div>
    </div>
  );
}
