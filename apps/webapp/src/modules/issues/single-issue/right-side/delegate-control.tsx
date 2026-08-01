/* eslint-disable @typescript-eslint/no-explicit-any */
import { RiArrowDownSLine, RiArrowRightSLine } from '@remixicon/react';
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
 * identity of its own that nobody has to provision or maintain — and no
 * executor picker, because work runs in the sandbox.
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
  const [showWhere, setShowWhere] = React.useState(false);
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

  const blocked = React.useMemo(() => {
    if ((issue?.description ?? '').length < MIN_DESCRIPTION_LENGTH) {
      return 'This issue is too thin to delegate. An agent given a one-line issue invents the requirements it was not given — say what the problem is and what done looks like first.';
    }
    if (liveRun) {
      return 'An agent is already working on this issue. Stop that run before starting another, or two branches nobody asked for come back.';
    }
    if (hosted && hosted.available === false) {
      // The server's own words. "No model key configured" is a settings page,
      // "no sandbox runtime" is an install, and a generic sentence is neither.
      return hosted.reason;
    }
    if (providers.length === 0 && catalogue) {
      return 'This workspace has no model key yet. Add one in Settings → Agents, and the provider and model become choices here.';
    }
    return undefined;
  }, [issue?.description, liveRun, hosted, providers.length, catalogue]);

  const start = () => {
    if (blocked || isPending) {
      return;
    }

    delegate({
      issueId: issue.id,
      // Named explicitly: with two executors registered the server refuses to
      // choose, and correctly — it is not its decision to make. Work runs in
      // the sandbox, so this is the answer.
      executor: HOSTED,
      ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
      ...(provider || modelId || thinking !== DEFAULT
        ? {
            config: {
              ...(provider ? { provider } : {}),
              ...(modelId ? { model: modelId } : {}),
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

              <div className="grid grid-cols-2 gap-2">
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
                  <Select
                    value={modelId ?? DEFAULT}
                    onValueChange={(value) =>
                      setModelId(value === DEFAULT ? undefined : value)
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      {/* The workspace default first and selected. Most runs
                          should not be a decision. */}
                      <SelectItem value={DEFAULT}>Workspace default</SelectItem>
                      {models.map((model: ModelChoiceOption) => (
                        <SelectItem key={model.id} value={model.id}>
                          {model.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
                    {THINKING.map((level) => (
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
                  Where it runs — a Vantik sandbox
                  {plan?.repoUrl || plan?.repoPath ? `, ${repoName(plan)}` : ''}
                  {plan?.baseBranch ? `, from ${plan.baseBranch}` : ''}
                </span>
              </button>

              {showWhere && (
                <p className="truncate pl-5 font-mono text-xs text-muted-foreground">
                  {plan?.repoUrl ?? plan?.repoPath ?? 'No repository resolved.'}
                </p>
              )}
            </>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border bg-grayAlpha-100 px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {plan
              ? `Stops at ${plan.limits.maxIterations} turns or $${plan.limits.maxCostUsd.toFixed(2)}.`
              : 'Runs against a ceiling.'}
            <br />
            {outcome(plan)}
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

/** Pi's `--thinking`, which the server already carries as `ModelChoice`. */
const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** The repository, from the end that identifies it. */
function repoName(plan: { repoUrl: string | null; repoPath: string | null }) {
  const value = plan.repoUrl ?? plan.repoPath ?? '';
  return (
    value
      .replace(/\.git$/, '')
      .split('/')
      .filter(Boolean)
      .pop() ?? value
  );
}

/** What will exist when it finishes, which is what a reader is agreeing to. */
function outcome(plan?: { delivery: string | null }): string {
  if (plan?.delivery === 'pull_request') {
    return 'Opens a branch and a pull request.';
  }
  if (plan?.delivery === 'worktree') {
    return 'Leaves the work on a branch for review.';
  }
  return 'Hands back a branch when it is done.';
}
