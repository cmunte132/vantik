import type { Workflow } from '@vantikhq/types';

import { updateWorkflow, type UpdateWorkflowInput } from '@vantikhq/services';

import { type MutationCallbacks, useApiMutation } from 'services/utils';

import { useContextStore } from 'store/global-context-provider';

export function useUpdateWorkflowMutation(
  callbacks: MutationCallbacks<Workflow, UpdateWorkflowInput> = {},
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
