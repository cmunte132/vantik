/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  type AgentRunCleanup,
  needsAgentRunCleanup,
  RETRYABLE_AGENT_RUN_STATUSES,
} from '@vantikhq/types';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@vantikhq/ui/components/alert-dialog';
import { Button } from '@vantikhq/ui/components/button';
import { useToast } from '@vantikhq/ui/components/use-toast';
import React from 'react';

import { useCleanUpRunMutation } from 'services/agent-runs';

import { pullNumber } from './run-feed';

interface Props {
  run: any;
  /** Opens the next attempt; given when the caller can retry this run. */
  onRetry?: () => void;
  size?: 'sm' | 'default';
}

/**
 * Removes what a finished run left on the git host: its pull request and its
 * branch. On a run awaiting review this is how a person rejects the work, so
 * it is named that, and offered together with a fresh attempt.
 *
 * Shown only while there is something to remove. The server keeps a branch
 * that has commits added since the run, so the dialog promises no more than
 * that.
 */
export function CleanUpRun({ run, onRetry, size = 'sm' }: Props) {
  const [open, setOpen] = React.useState(false);
  const { toast } = useToast();
  const retryAfter = React.useRef(false);

  const { mutate: cleanUp, isPending } = useCleanUpRunMutation({
    onSuccess: (cleanup) => {
      setOpen(false);
      const failed =
        cleanup.pullRequest === 'failed' || cleanup.branch === 'failed';
      toast({
        variant: failed ? 'destructive' : 'default',
        title: failed ? 'Cleaned up in part' : 'Cleaned up',
        description: describe(cleanup),
      });
      if (retryAfter.current) {
        onRetry?.();
      }
    },
    onError: (message) => {
      toast({
        variant: 'destructive',
        title: 'Could not clean up',
        description: message,
      });
    },
  });

  if (!needsAgentRunCleanup(run)) {
    return null;
  }

  const reviewing = run.status === 'NEEDS_REVIEW';
  const verb = reviewing ? 'Reject' : 'Clean up';
  const result = run.result ?? {};
  const pr = pullNumber(result.prUrl);
  const canRetry =
    Boolean(onRetry) && RETRYABLE_AGENT_RUN_STATUSES.includes(run.status);

  const start = (andRetry: boolean) => {
    retryAfter.current = andRetry;
    cleanUp({ runId: run.id });
  };

  return (
    <>
      <Button variant="secondary" size={size} onClick={() => setOpen(true)}>
        {verb}
      </Button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {reviewing ? 'Reject this work?' : 'Clean up after this run?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {[
                result.prUrl &&
                  `Closes ${pr ? `pull request #${pr}` : 'the pull request'} with a comment saying why.`,
                result.branch &&
                  `Deletes ${result.branch}, unless someone has added commits to it since.`,
                'The run and its record stay as they are.',
              ]
                .filter(Boolean)
                .join(' ')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <Button
              variant="secondary"
              disabled={isPending}
              onClick={() => start(false)}
            >
              {verb}
            </Button>
            {canRetry && (
              <AlertDialogAction
                disabled={isPending}
                onClick={(event) => {
                  // Closed by the mutation, so a failure keeps it open.
                  event.preventDefault();
                  start(true);
                }}
              >
                {verb} and retry
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** What a cleanup did, in a sentence or two. */
export function describe(cleanup: AgentRunCleanup): string {
  const parts = [
    {
      closed: 'Closed the pull request.',
      already_closed: 'The pull request was already closed.',
      merged: 'The pull request was already merged, so it was left.',
      failed: 'Could not close the pull request.',
      none: '',
    }[cleanup.pullRequest],
    {
      deleted: 'Deleted the branch.',
      already_gone: 'The branch was already gone.',
      kept_moved: 'Kept the branch: commits were added to it since the run.',
      kept: 'Kept the branch.',
      failed: 'Could not delete the branch.',
      none: '',
    }[cleanup.branch],
  ];

  if (cleanup.pullRequest === 'failed' || cleanup.branch === 'failed') {
    parts.push(cleanup.detail ?? '');
  }

  return parts.filter(Boolean).join(' ');
}
