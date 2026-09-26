import { ajaxDelete, mutationHook } from 'services/utils';

export interface DeleteLabelParams {
  labelId: string;
}

export function deleteLabel({ labelId }: DeleteLabelParams) {
  return ajaxDelete({
    url: `/api/v1/labels/${labelId}`,
  });
}

export const useDeleteLabelMutation = mutationHook(deleteLabel);
