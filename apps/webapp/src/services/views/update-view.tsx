import type { ViewType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

import type { FiltersModelType } from 'store/application';

export interface UpdateViewParams {
  name?: string;
  description?: string;
  filters: FiltersModelType;
  viewId: string;
  isBookmarked?: boolean;
}

export function updateView({
  viewId,
  ...otherParams
}: UpdateViewParams): Promise<ViewType> {
  return ajaxPost({
    url: `/api/v1/views/${viewId}`,
    data: {
      ...otherParams,
    },
  });
}

export const useUpdateViewMutation = mutationHook(updateView);
