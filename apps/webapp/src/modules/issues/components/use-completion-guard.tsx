import { WorkflowCategoryEnum } from '@vantikhq/types';
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
import * as React from 'react';

import type { ChecklistItemType } from 'common/types';

import { useAllWorkflows } from 'hooks/workflows';

import { useContextStore } from 'store/global-context-provider';

/**
 * Warns before an issue is completed with acceptance criteria still unchecked,
 * for any of the several places that can complete one.
 *
 * This lived inside the single-issue right-hand panel, which meant the one status
 * dropdown there was warned about and nothing else was: dragging a card into a
 * Done column, the status dropdown on a list row, on a board card, and on the
 * narrow single-issue header all completed an issue silently. A caller wraps its
 * own status change in `guard` and renders `dialog`; the decision and the copy
 * then live in one place rather than being re-implemented per affordance.
 *
 * Workflows are read across every team rather than for one, because the callers
 * that most need this — the board and the list — show issues from several.
 */
export function useCompletionGuard() {
  const { checklistItemsStore } = useContextStore();
  const workflows = useAllWorkflows();

  // The change being held back until it is confirmed, with the criteria counts
  // as they stood when it was proposed.
  const [pending, setPending] = React.useState<{
    apply: () => void;
    open: number;
    total: number;
  } | null>(null);

  /**
   * Runs `apply` now, or holds it until the warning is accepted. Callers that
   * are not changing state to a completed one are unaffected.
   */
  const guard = React.useCallback(
    (issueId: string, stateId: string, apply: () => void) => {
      const nextWorkflow = workflows?.find(
        (workflow: { id: string }) => workflow.id === stateId,
      );

      if (nextWorkflow?.category !== WorkflowCategoryEnum.COMPLETED) {
        apply();
        return;
      }

      const criteria = checklistItemsStore.getChecklistItems(
        issueId,
      ) as ChecklistItemType[];
      const open = criteria.filter(
        (item: ChecklistItemType) => !item.completed,
      ).length;

      if (open === 0) {
        apply();
        return;
      }

      setPending({ apply, open, total: criteria.length });
    },
    [workflows, checklistItemsStore],
  );

  const dialog = (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => !open && setPending(null)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Definition of Done not met</AlertDialogTitle>
          <AlertDialogDescription>
            {pending?.open} of {pending?.total} criteria are still unchecked.
            You can still complete this issue.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              pending?.apply();
              setPending(null);
            }}
          >
            Complete anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { guard, dialog };
}
