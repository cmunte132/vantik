import type { DragStart, DropResult } from '@hello-pangea/dnd';
import { DragDropContext, Droppable } from '@hello-pangea/dnd';

import { WorkflowCategoryEnum } from '@vantikhq/types';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { SettingSection } from 'modules/settings/setting-section';

import { type WorkflowType } from 'common/types';

import { useCurrentTeam } from 'hooks/teams';
import { workflowSort } from 'hooks/workflows';

import { useUpdateWorkflowMutation } from 'services/workflow';

import { useContextStore } from 'store/global-context-provider';

import { WorkflowCategory } from './workflow-category';

export const Workflow = observer(() => {
  const { workflowsStore } = useContextStore();
  const [currentCategory, setCurrentCategory] =
    React.useState<WorkflowCategoryEnum>();
  const team = useCurrentTeam();
  const { mutate: updateWorkflow } = useUpdateWorkflowMutation({
    onSuccess: () => {},
  });

  const getWorkflows = React.useCallback(
    (categoryName: string) => {
      return workflowsStore
        .getWorkflowsForTeam(team.id)
        .filter((workflow: WorkflowType) => workflow.category === categoryName)
        .sort(workflowSort);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workflowsStore.workflows, team.id],
  );

  const onDragEnd = (result: DropResult) => {
    setCurrentCategory(undefined);
    if (!result.destination) {
      return;
    }

    const workflowId = result.draggableId;

    const workflow = workflowsStore.getWorkflowWithId(workflowId);
    updateWorkflow({
      teamId: workflow.teamId,
      workflowId: workflow.id,
      name: workflow.name,
      description: workflow.description,
      color: workflow.color,
      category: workflow.category,
      position: result.destination.index,
    });
  };

  const onDragStart = (start: DragStart) => {
    const workflow = workflowsStore.getWorkflowWithId(start.draggableId);
    setCurrentCategory(workflow.category);
  };

  return (
    <SettingSection
      title="Workflow"
      description="Workflows define the type and order of statuses that issues go through
    from start to completion. Here you can customize and re-order the
    available workflow statuses."
    >
      <DragDropContext onDragEnd={onDragEnd} onDragStart={onDragStart}>
        <div className="flex flex-col w-full">
          {Object.values(WorkflowCategoryEnum).map((category) => {
            return (
              <Droppable
                droppableId={category}
                key={category}
                isDropDisabled={Boolean(
                  currentCategory && currentCategory !== category,
                )}
              >
                {(provided) => (
                  <div ref={provided.innerRef} {...provided.droppableProps}>
                    <WorkflowCategory
                      categoryName={category}
                      workflows={getWorkflows(category)}
                    />
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            );
          })}
        </div>
      </DragDropContext>
    </SettingSection>
  );
});
