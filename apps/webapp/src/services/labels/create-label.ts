import type { LabelType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

export interface CreateLabelParams {
  name: string;
  color: string;
  workspaceId: string;

  groupId?: string;
  teamId?: string;
}

export function createLabel(params: CreateLabelParams): Promise<LabelType> {
  return ajaxPost({
    url: '/api/v1/labels',
    data: params,
  });
}

export const useCreateLabelMutation = mutationHook(createLabel);
