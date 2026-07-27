/* eslint-disable @typescript-eslint/no-explicit-any */
import { Button } from '@vantikhq/ui/components/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@vantikhq/ui/components/tooltip';
import { observer } from 'mobx-react-lite';
import React from 'react';

import { useIssueData } from 'hooks/issues';
import { useCurrentWorkspace } from 'hooks/workspace';

import { useDelegateMutation, useExecutors } from 'services/agent-runs';

import { useContextStore } from 'store/global-context-provider';

const LIVE = ['QUEUED', 'CLAIMED', 'RUNNING'];

/** Below this an issue is not a problem statement, matching the server. */
const MIN_DESCRIPTION_LENGTH = 40;

/**
 * Hands this issue to an agent.
 *
 * Disabled states carry their reason rather than being mysteriously grey. The
 * three that actually happen — no agent account, an issue too thin to act on,
 * a run already in flight — are each a different thing for the user to do
 * next, and a button that just does not work is a support ticket.
 *
 * The thin-issue check is duplicated from the server deliberately. The server
 * is the authority and refuses regardless; this is only so the reason appears
 * before someone clicks rather than after.
 */
export const DelegateControl = observer(() => {
  const issue = useIssueData();
  const workspace = useCurrentWorkspace();
  const { agentRunsStore, workspaceStore } = useContextStore();
  const [error, setError] = React.useState<string | undefined>();

  const { data: executors } = useExecutors();
  const { mutate: delegate, isPending } = useDelegateMutation({
    onSuccess: () => setError(undefined),
    onError: setError,
  });

  const agents: any[] = React.useMemo(
    () =>
      [...(workspaceStore?.usersOnWorkspaces ?? [])].filter(
        (member: any) => member.role === 'AGENT' && member.status === 'ACTIVE',
      ),
    [workspaceStore?.usersOnWorkspaces],
  );

  const current = agentRunsStore.getCurrentRunForIssue(issue?.id);
  const liveRun = current && LIVE.includes(current.status) ? current : undefined;

  const usable: any[] = ((executors as any[]) ?? []).filter(
    (entry: any) => entry.available,
  );

  const blocked = React.useMemo(() => {
    if (agents.length === 0) {
      return 'No agent accounts in this workspace yet. Create one in account settings.';
    }
    if ((issue?.description ?? '').length < MIN_DESCRIPTION_LENGTH) {
      return 'This issue is too thin to delegate. An agent given a one-line issue invents the requirements it was not given — say what the problem is and what done looks like first.';
    }
    if (liveRun) {
      return 'An agent is already working on this issue.';
    }
    if (usable.length === 0 && executors) {
      // Name the first reason rather than a generic one: "no model key
      // configured" is a settings page, "no sandbox runtime" is an install.
      return (
        (executors as any[])[0]?.reason ??
        'No executor in this deployment can take work right now.'
      );
    }
    return undefined;
  }, [agents.length, issue?.description, liveRun, usable.length, executors]);

  if (!workspace || liveRun) {
    // A live run means the panel below is already saying everything useful.
    return null;
  }

  const button = (
    <Button
      variant="secondary"
      size="sm"
      disabled={Boolean(blocked) || isPending}
      onClick={() =>
        delegate({
          issueId: issue.id,
          // Named only when there is a choice; with one agent the server
          // infers it, and making someone pick from a list of one is friction.
          ...(agents.length === 1 ? {} : { agentUserId: agents[0]?.userId }),
          ...(usable.length === 1 ? { executor: usable[0].key } : {}),
        })
      }
    >
      {isPending ? 'Delegating…' : 'Delegate to an agent'}
    </Button>
  );

  return (
    <div className="flex flex-col gap-1 py-2">
      {blocked ? (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* A disabled button swallows pointer events, so the tooltip needs
                something that does not. */}
            <span className="inline-flex w-fit">{button}</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">{blocked}</TooltipContent>
        </Tooltip>
      ) : (
        button
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
});
