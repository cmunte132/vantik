import { ajaxDelete, mutationHook } from 'services/utils';

export interface DeleteViewParams {
  viewId: string;
}

export function deleteView({ viewId }: DeleteViewParams) {
  return ajaxDelete({
    url: `/api/v1/views/${viewId}`,
  });
}

export const useDeleteViewMutation = mutationHook(deleteView);
