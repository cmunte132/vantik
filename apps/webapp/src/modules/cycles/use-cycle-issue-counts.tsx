import { WorkflowCategory } from '@vantikhq/types';
import React from 'react';

import type { IssueType, WorkflowType } from 'common/types';

import { useComputedWorkflows } from 'hooks/workflows';

import { useContextStore } from 'store/global-context-provider';

/**
 * How much of a cycle is done, and how much is not.
 *
 * The complete-cycle dialog has to say what it is about to move before it moves
 * it — "3 issues will go to the backlog" is the whole point of the confirmation
 * — and it counts finished the same way the server does when it decides what to
 * move: by the workflow state's category, which is a per-team decision.
 */
export function useCycleIssueCounts(cycleId?: string) {
  const { issuesStore } = useContextStore();
  const { workflows } = useComputedWorkflows();

  const issues = issuesStore.getIssuesForCycle({ cycleId });

  return React.useMemo(() => {
    const finished = issues.filter((issue: IssueType) => {
      const workflow = workflows.find((workflow: WorkflowType) =>
        workflow.ids.includes(issue.stateId),
      );

      return (
        workflow &&
        (workflow.category === WorkflowCategory.COMPLETED ||
          workflow.category === WorkflowCategory.CANCELED)
      );
    });

    return {
      total: issues.length,
      finished: finished.length,
      unfinished: issues.length - finished.length,
    };
  }, [issues, workflows, cycleId]);
}
