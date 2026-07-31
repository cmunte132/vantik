import type { AgentRunVerification } from '@vantikhq/types';

import { useQuery } from '@tanstack/react-query';
import { getModules } from '@vantikhq/services';
import { Button } from '@vantikhq/ui/components/button';
import { Input } from '@vantikhq/ui/components/input';
import * as React from 'react';

import { useUpdateModuleMutation } from 'services/product-axis';

/**
 * How an agent run checks work in this module.
 *
 * Whether the agent can run this module's own tests and react to the output is
 * the difference between a plausible diff and a working one — the context pack
 * treats it as the highest-leverage thing it carries.
 *
 * Here rather than in workspace settings because the command depends on the
 * code and on nothing else. One workspace can hold a Go service and a pnpm
 * monorepo, and no single `testCommand` is right for both. A module is already
 * where a run is grounded — the issue names modules, the modules name the
 * repository and the paths inside it — so this sits on the same hook, and an
 * issue filed against a module reaches a run that can verify itself with
 * nothing else configured.
 *
 * Everything is optional. An empty command is a step the run skips, which is
 * the right answer for a module with no build — so blanks are stored as absent
 * rather than as an empty string the runner would try to execute.
 */
const FIELDS: Array<{
  key: keyof AgentRunVerification;
  label: string;
  placeholder: string;
}> = [
  { key: 'testCommand', label: 'Tests', placeholder: 'pnpm turbo test' },
  {
    key: 'typecheckCommand',
    label: 'Typecheck',
    placeholder: 'pnpm turbo typecheck',
  },
  { key: 'lintCommand', label: 'Lint', placeholder: 'pnpm turbo lint' },
  { key: 'buildCommand', label: 'Build', placeholder: 'pnpm turbo build' },
];

export function Verification({ moduleId }: { moduleId: string }) {
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  // `verification` is not on the replicated model, so it does not arrive over
  // the socket — the same reason this page fetches a module's repositories by
  // hand. Widening the synced model would need a Dexie bump and a resync to
  // reach clients that already exist, for a field only this page reads.
  const { data: modules = [], refetch } = useQuery({
    queryKey: ['modules', 'verification'],
    queryFn: () => getModules(),
  });

  const stored = (modules.find((entry) => entry.id === moduleId)
    ?.verification ?? {}) as AgentRunVerification;

  // Local until saved, so a half-typed command is never what a run picks up.
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [setupDraft, setSetupDraft] = React.useState<string | null>(null);

  const valueOf = (key: keyof AgentRunVerification) =>
    draft[key] ?? (stored[key] as string | undefined) ?? '';
  const setupValue = setupDraft ?? (stored.setupCommands ?? []).join('\n');

  const { mutate: updateModule, isPending } = useUpdateModuleMutation({
    onSuccess: () => {
      refetch();
      setDraft({});
      setSetupDraft(null);
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
    onError: setError,
  });

  const dirty = Object.keys(draft).length > 0 || setupDraft !== null;

  const save = () => {
    // The column is replaced rather than merged, so the whole object is built
    // here from what is stored plus what was typed.
    const next: Record<string, unknown> = { ...stored };

    for (const [key, value] of Object.entries(draft)) {
      const trimmed = value.trim();

      if (trimmed) {
        next[key] = trimmed;
      } else {
        // An emptied field means "do not run this", which is absence rather
        // than an empty command.
        delete next[key];
      }
    }

    if (setupDraft !== null) {
      const lines = setupDraft
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      if (lines.length > 0) {
        next.setupCommands = lines;
      } else {
        delete next.setupCommands;
      }
    }

    updateModule({ moduleId, verification: next });
  };

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {FIELDS.map((field) => (
          <div key={field.key} className="flex flex-col gap-1 min-w-0">
            <label className="text-muted-foreground">{field.label}</label>
            <Input
              className="font-mono"
              value={valueOf(field.key)}
              placeholder={field.placeholder}
              onChange={(event) => {
                // Read before the updater runs. `currentTarget` is only valid
                // while the event is being dispatched, and a functional
                // setState callback runs after that — reading it in there
                // throws on null the first time anyone types.
                const { value } = event.currentTarget;

                setDraft((current) => ({ ...current, [field.key]: value }));
              }}
            />
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-muted-foreground">
          Setup — one command per line, run once before the agent starts
        </label>
        <textarea
          className="rounded-md border border-border bg-transparent p-2 font-mono min-h-[64px]"
          placeholder={'pnpm install\npnpm prisma generate'}
          value={setupValue}
          onChange={(event) => setSetupDraft(event.currentTarget.value)}
        />
      </div>

      {(dirty || saved) && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            isLoading={isPending}
            disabled={!dirty}
            onClick={save}
          >
            Save
          </Button>
          {saved && !dirty && (
            <span className="text-muted-foreground">Saved.</span>
          )}
        </div>
      )}

      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}
