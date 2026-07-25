import type { DropResult } from '@hello-pangea/dnd';

import { Board } from '@vantikhq/ui/components/board';
import { observer } from 'mobx-react-lite';

import type { WorkflowType } from 'common/types';

import { useCompletionGuard } from 'modules/issues/components/use-completion-guard';

import { useComputedWorkflows } from 'hooks/workflows';

import { useUpdateIssueMutation } from 'services/issues';

import { useContextStore } from 'store/global-context-provider';

import { CategoryBoardList } from './category-board-list';

interface CategoryBoardProps {
  workflows: WorkflowType[];
}

export const CategoryBoard = observer(({ workflows }: CategoryBoardProps) => {
  const { mutate: updateIssue } = useUpdateIssueMutation({});
  const { issuesStore } = useContextStore();
  const { workflowMap } = useComputedWorkflows();
  const { guard, dialog } = useCompletionGuard();

  const onDragEnd = (result: DropResult) => {
    const issueId = result.draggableId;

    if (!result.destination) {
      return;
    }

    const workflowName = result.destination.droppableId;
    const issue = issuesStore.getIssueById(issueId);

    const workflowIds = workflows.find(
      (workflow) => workflow.name === workflowName,
    ).ids;

    const workflowId = workflowIds.find(
      (workflowId) => workflowMap[workflowId].teamId === issue.teamId,
    );

    if (issue.stateId !== workflowId) {
      // Dragging a card into a Done column completes the issue as surely as the
      // status dropdown does, so it asks the same question first.
      guard(issueId, workflowId, () =>
        updateIssue({ id: issueId, stateId: workflowId, teamId: issue.teamId }),
      );
    }
  };

  return (
    <Board onDragEnd={onDragEnd} className="pl-4">
      <>
        {dialog}
        {workflows.map((workflow: WorkflowType) => {
          return (
            <CategoryBoardList
              key={workflow.name}
              workflow={workflow}
              workflows={workflows}
            />
          );
        })}
      </>
    </Board>
  );
});
