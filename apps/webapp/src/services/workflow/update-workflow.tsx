import type {
  UpdateWorkflowDTO,
  WorkflowRequestParamsDto,
} from '@vantikhq/types';

import type { WorkflowType } from 'common/types';

import {
  ajaxPost,
  type MutationCallbacks,
  useApiMutation,
} from 'services/utils';

import { useContextStore } from 'store/global-context-provider';

export interface UpdateWorkflowInput
  extends WorkflowRequestParamsDto, UpdateWorkflowDTO {}

export function updateWorkflow({
  teamId,
  workflowId,
  ...data
}: UpdateWorkflowInput): Promise<WorkflowType> {
  return ajaxPost({ url: `/api/v1/${teamId}/workflows/${workflowId}`, data });
}

export function useUpdateWorkflowMutation(
  callbacks: MutationCallbacks<WorkflowType, UpdateWorkflowInput> = {},
) {
  const { workflowsStore } = useContextStore();

  const update = ({ workflowId, ...otherParams }: UpdateWorkflowInput) => {
    const workflow = workflowsStore.getWorkflowWithId(workflowId);

    try {
      workflowsStore.update(
        { ...workflow, position: otherParams.position },
        workflowId,
      );

      return updateWorkflow({ ...otherParams, workflowId });
    } catch (e) {
      workflowsStore.update(workflow, workflowId);
      return undefined;
    }
  };

  return useApiMutation(update, callbacks);
}
