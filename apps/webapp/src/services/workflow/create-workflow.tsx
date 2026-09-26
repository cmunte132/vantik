import type {
  CreateWorkflowDTO,
  WorkflowRequestParamsDto,
} from '@vantikhq/types';

import type { WorkflowType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

export interface CreateWorkflowInput
  extends WorkflowRequestParamsDto, CreateWorkflowDTO {}

export function createWorkflow({
  teamId,
  ...data
}: CreateWorkflowInput): Promise<WorkflowType> {
  return ajaxPost({ url: `/api/v1/${teamId}/workflows`, data });
}

export const useCreateWorkflowMutation = mutationHook(createWorkflow);
