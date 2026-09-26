import type { LabelType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

interface UpdateLabelParams {
  name: string;
  labelId: string;
}

export function updateLabel(params: UpdateLabelParams): Promise<LabelType> {
  const { labelId, ...otherParams } = params;

  return ajaxPost({
    url: `/api/v1/labels/${labelId}`,
    data: otherParams,
  });
}

export const useUpdateLabelMutation = mutationHook(updateLabel);
