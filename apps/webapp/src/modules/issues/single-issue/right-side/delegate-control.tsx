/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ConnectorModel } from '@vantikhq/types';

import {
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiCloudLine,
  RiComputerLine,
} from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@vantikhq/ui/components/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vantikhq/ui/components/select';
import { Textarea } from '@vantikhq/ui/components/textarea';
import { observer } from 'mobx-react-lite';
import React from 'react';

import { ModelPicker } from 'modules/agent-runs/model-picker';

import { useIssueData } from 'hooks/issues';
import { useCurrentWorkspace } from 'hooks/workspace';

import {
  type ModelChoiceOption,
  useDelegateMutation,
  useExecutors,
  useModelCatalogue,
  useRunPlan,
} from 'services/agent-runs';

import { useContextStore } from 'store/global-context-provider';

/** Below this an issue is not a problem statement, matching the server. */
const MIN_DESCRIPTION_LENGTH = 40;

const LIVE = ['QUEUED', 'CLAIMED', 'RUNNING'];

/**
 * Vantik runs the agent. This is where you say what it should run on.
 *
 * The sheet always opens. There is no split button and no defaults path,
 * because a wasted run costs more than a keystroke — and because the field
 * that changes outcomes most is the one with no default, which is the sentence
 * of guidance the issue does not contain. The cursor lands there, and ⌘↵
 * starts the run without touching anything else.
 *
 * The three knobs are provider, model and reasoning, in that order, because
 * that is the order they constrain each other: the workspace's keys decide the
 * providers, the provider decides the models, and only some models do anything
 * with a reasoning level. There is no agent picker — a hosted run is given an
 * identity of its own that nobody has to provision or maintain. Where the run
 * happens is always stated at the top, and becomes a choice only for a person
 * who has more than one place to run: the sandbox, and their own machine while
 * `vantik connect` is running on it.
 */
export const DelegateControl = observer(() => {
  const issue = useIssueData();
  const workspace = useCurrentWorkspace();
  const { agentRunsStore } = useContextStore();

  const [open, setOpen] = React.useState(false);
  const [guidance, setGuidance] = React.useState('');
  const [provider, setProvider] = React.useState<string>();
  const [modelId, setModelId] = React.useState<string>();
  const [thinking, setThinking] = React.useState<string>(DEFAULT);
  // A local run picks from the models of the person's own omp, not from the
  // workspace's providers, so it keeps its own choice.
  const [localProvider, setLocalProvider] = React.useState<string>(DEFAULT);
  const [localModelId, setLocalModelId] = React.useState<string>();
  const [showWhere, setShowWhere] = React.useState(false);
  const [chosenExecutor, setChosenExecutor] = React.useState<string>();
  const [error, setError] = React.useState<string>();

  const { data: executors } = useExecutors();
  const { data: catalogue } = useModelCatalogue();
  const { data: plan } = useRunPlan(open ? issue?.id : undefined);

  const { mutate: delegate, isPending } = useDelegateMutation({
    onSuccess: () => {
      setOpen(false);
      setGuidance('');
      setError(undefined);
    },
    onError: setError,
  });

  const providers = catalogue?.providers ?? [];

  // Only this provider's models. OpenRouter alone answers with 367, and the
  // whole reason provider comes first is that the flat list is unusable.
  const models = React.useMemo(
    () =>
      (catalogue?.models ?? []).filter(
        (model: ModelChoiceOption) => model.provider === provider,
      ),
    [catalogue?.models, provider],
  );

  const hosted = React.useMemo(
    () =>
      ((executors as any[]) ?? []).find((entry: any) => entry.key === HOSTED),
    [executors],
  );

  // What this person can run on right now. The server answers per person: the
  // local executor is available only while their own connector is online.
  const usable = React.useMemo(
    () =>
      ((executors as any[]) ?? []).filter(
        (entry: any) => entry.available !== false,
      ),
    [executors],
  );

  // The hosted sandbox unless the person picked another, or it cannot be used
  // and something else can. A stale choice (the connector went offline) falls
  // back rather than blocking.
  const executor: string =
    usable.find((entry: any) => entry.key === chosenExecutor)?.key ??
    usable.find((entry: any) => entry.key === HOSTED)?.key ??
    usable[0]?.key ??
    HOSTED;
  const local = executor === LOCAL;

  // What the person's omp offers. A connector that sent no models leaves the
  // pickers out and omp on its own default.
  const localEntry = usable.find((entry: any) => entry.key === LOCAL);
  const localModels: ConnectorModel[] = React.useMemo(
    () => (localEntry?.models as ConnectorModel[] | undefined) ?? [],
    [localEntry?.models],
  );
  const localDefault: string | null = localEntry?.defaultModel ?? null;
  const localChoice = local && localModels.length > 0;

  const localProviders = React.useMemo(
    () => [...new Set(localModels.map((model) => model.provider))],
    [localModels],
  );
  const localOptions: ModelChoiceOption[] = React.useMemo(
    () =>
      localModels
        .filter((model) => model.provider === localProvider)
        .map((model) => ({
          provider: model.provider,
          id: model.id,
          label: model.name,
        })),
    [localModels, localProvider],
  );
  const localModel = localModels.find(
    (model) => model.provider === localProvider && model.id === localModelId,
  );

  // The levels the chosen model takes, or the standard list when omp did not
  // say (or no model is chosen and omp's default applies).
  const levels = localChoice
    ? (localModel?.thinkingLevels ?? THINKING)
    : THINKING;

  const current = agentRunsStore.getCurrentRunForIssue(issue?.id);
  const liveRun =
    current && LIVE.includes(current.status) ? current : undefined;

  // One configured provider is not a choice, so it is made rather than asked.
  React.useEffect(() => {
    setProvider((chosen) => chosen ?? providers[0]);
  }, [providers]);

  // A provider change invalidates the model under it.
  React.useEffect(() => {
    setModelId(undefined);
  }, [provider]);

  // A level the new model does not take is dropped rather than sent.
  React.useEffect(() => {
    if (thinking !== DEFAULT && !levels.includes(thinking)) {
      setThinking(DEFAULT);
    }
  }, [levels, thinking]);

  const blocked = React.useMemo(() => {
    if ((issue?.description ?? '').length < MIN_DESCRIPTION_LENGTH) {
      return 'This issue is too thin to delegate. An agent given a one-line issue invents the requirements it was not given — say what the problem is and what done looks like first.';
    }
    if (liveRun) {
      return 'An agent is already working on this issue. Stop that run before starting another, or two branches nobody asked for come back.';
    }
    if (!local && hosted && hosted.available === false) {
      // The server's own words. "No model key configured" is a settings page,
      // "no sandbox runtime" is an install, and a generic sentence is neither.
      return hosted.reason;
    }
    if (!local && providers.length === 0 && catalogue) {
      return 'This workspace has no model key yet. Add one in Settings → Agents, and the provider and model become choices here.';
    }
    return undefined;
  }, [issue?.description, liveRun, hosted, local, providers.length, catalogue]);

  const start = () => {
    if (blocked || isPending) {
      return;
    }

    delegate({
      issueId: issue.id,
      // Named explicitly rather than left to the server's fallback, so a
      // backend registered later never changes what this control starts.
      executor,
      ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
      ...((!local && (provider || modelId)) ||
      (localChoice && localProvider !== DEFAULT) ||
      thinking !== DEFAULT
        ? {
            config: {
              // A local run uses the models the person is signed in to in
              // omp, so the workspace's providers do not apply to it. Nothing
              // chosen sends nothing, and omp's own default applies.
              ...(!local && provider ? { provider } : {}),
              ...(!local && modelId ? { model: modelId } : {}),
              ...(localChoice && localProvider !== DEFAULT
                ? { provider: localProvider }
                : {}),
              ...(localChoice && localProvider !== DEFAULT && localModelId
                ? { model: localModelId }
                : {}),
              ...(thinking !== DEFAULT ? { thinking } : {}),
            },
          }
        : {}),
    });
  };

  if (!workspace || liveRun) {
    // A live run means the card in the activity feed is already saying
    // everything useful, and offering to start a second one is not useful.
    return null;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="sm">
          Delegate to an agent
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="w-[420px] p-0"
        onKeyDown={(event) => {
          // Start from the keyboard without leaving the guidance field, which
          // is the whole point of pre-filling everything else.
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            start();
          }
        }}
      >
        <div className="flex flex-col gap-3 p-3">
          {blocked ? (
            <p className="text-muted-foreground">{blocked}</p>
          ) : (
            <>
              {/* Where the run happens leads, because it decides everything
                  under it: whose models, whose machine, what comes back. With
                  one place to run it is stated, not offered — but always
                  stated, so nobody starts a run without knowing where. */}
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Runs on</label>
                {usable.length > 1 ? (
                  <Select value={executor} onValueChange={setChosenExecutor}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {usable.map((entry: any) => (
                        <SelectItem key={entry.key} value={entry.key}>
                          {placeName(entry.key, entry.label)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="flex items-center gap-2 rounded-md bg-grayAlpha-100 px-2 py-1.5">
                    {local ? (
                      <RiComputerLine size={14} />
                    ) : (
                      <RiCloudLine size={14} />
                    )}
                    <span>{placeName(executor)}</span>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  {local
                    ? 'Your omp setup, with the models you are signed in to there. The work stays in a git worktree on your machine.'
                    : "A Vantik sandbox, with the workspace's model keys."}
                </p>
                {local && localEntry?.ompSupported === false && (
                  <p className="text-xs text-amber-600">
                    Your omp {localEntry.ompVersion ?? ''} is not a version
                    that Vantik is tested with. The run can still work.
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">
                  Anything the issue does not already say
                </label>
                <Textarea
                  autoFocus
                  rows={3}
                  value={guidance}
                  onChange={(event) => setGuidance(event.target.value)}
                  placeholder="Follow the existing spec style in this folder. Do not touch the migration."
                />
              </div>

              {localChoice && (
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">
                      Provider
                    </label>
                    <Select
                      value={localProvider}
                      onValueChange={(value) => {
                        setLocalProvider(value);
                        setLocalModelId(undefined);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DEFAULT}>
                          {localDefault
                            ? `omp default (${localDefault})`
                            : 'omp default'}
                        </SelectItem>
                        {localProviders.map((key) => (
                          <SelectItem key={key} value={key}>
                            {key}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground">
                      Model
                    </label>
                    <ModelPicker
                      models={localOptions}
                      value={localModelId}
                      noneLabel="omp default"
                      onChange={setLocalModelId}
                    />
                  </div>
                </div>
              )}

              <div className={local ? 'hidden' : 'grid grid-cols-2 gap-2'}>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">
                    Provider
                  </label>
                  <Select value={provider} onValueChange={setProvider}>
                    <SelectTrigger>
                      <SelectValue placeholder="Workspace default" />
                    </SelectTrigger>
                    <SelectContent>
                      {providers.map((key: string) => (
                        <SelectItem key={key} value={key}>
                          {key}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">Model</label>
                  <ModelPicker
                    models={models}
                    value={modelId}
                    noneLabel="Workspace default"
                    onChange={setModelId}
                  />
                </div>
              </div>

              {/* Reasoning is a knob only some models have. It is offered
                  rather than hidden because nothing in a model catalogue says
                  which — the id and the label are all a provider returns — and
                  a control that silently does nothing on a model that ignores
                  it is a smaller failure than one that cannot be reached on a
                  model that honours it. */}
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">
                  Reasoning effort
                </label>
                <Select value={thinking} onValueChange={setThinking}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT}>Model default</SelectItem>
                    {levels.map((level) => (
                      <SelectItem key={level} value={level}>
                        {level}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <button
                type="button"
                onClick={() => setShowWhere(!showWhere)}
                className="flex items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
              >
                {showWhere ? (
                  <RiArrowDownSLine size={12} />
                ) : (
                  <RiArrowRightSLine size={12} />
                )}
                <span className="truncate">
                  Repository — {plan?.repository ?? 'not resolved'}
                  {plan?.baseBranch ? `, from ${plan.baseBranch}` : ''}
                </span>
              </button>

              {showWhere && (
                <p className="truncate pl-5 font-mono text-xs text-muted-foreground">
                  {plan?.location ?? 'No repository resolved.'}
                </p>
              )}
            </>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border bg-grayAlpha-100 px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {local
              ? 'Stops if it runs past its deadline.'
              : plan
                ? `Stops at ${plan.limits.maxIterations} turns or $${plan.limits.maxCostUsd.toFixed(2)}.`
                : 'Runs against a ceiling.'}
            <br />
            {local
              ? 'Leaves a branch in a worktree on your machine.'
              : outcome(plan)}
          </span>

          <Button
            size="sm"
            disabled={Boolean(blocked) || isPending}
            onClick={start}
          >
            {isPending ? 'Starting…' : 'Start run'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
});

/** Radix rejects an empty option value, so "unset" needs a name. */
const DEFAULT = 'default';

/** Work runs in the sandbox. Matches `HOSTED_EXECUTOR_KEY` on the server. */
const HOSTED = 'hosted';

/** Work runs on the person's machine. Matches `LOCAL_EXECUTOR_KEY`. */
const LOCAL = 'local';

/** Pi's `--thinking`, which the server already carries as `ModelChoice`. */
const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** The place a run happens, in the words a person would use for it. */
function placeName(key: string, fallback?: string): string {
  if (key === LOCAL) {
    return 'Your machine (omp)';
  }
  if (key === HOSTED) {
    return 'Vantik sandbox';
  }
  return fallback ?? key;
}

/** What will exist when it finishes, which is what a reader is agreeing to. */
function outcome(plan?: { delivery: string | null }): string {
  if (plan?.delivery === 'pull_request') {
    return 'Opens a branch and a pull request.';
  }
  if (plan?.delivery === 'branch') {
    return 'Pushes a branch into the repository for review.';
  }
  return 'Hands back a branch when it is done.';
}
