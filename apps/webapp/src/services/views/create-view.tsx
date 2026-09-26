import type { ViewType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

import type { FiltersModelType } from 'store/application';

export interface CreateViewParams {
  workspaceId: string;
  filters: FiltersModelType;
  teamId?: string;
  name: string;
  description?: string;
}

export function createView({
  workspaceId,
  ...otherParams
}: CreateViewParams): Promise<ViewType> {
  return ajaxPost({
    url: `/api/v1/views`,
    data: {
      workspaceId,
      ...otherParams,
    },
  });
}

export const useCreateViewMutation = mutationHook(createView);
