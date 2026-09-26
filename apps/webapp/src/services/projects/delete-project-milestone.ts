import { deleteProjectMilestone } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

export const useDeleteProjectMilestoneMutation = mutationHook(
  deleteProjectMilestone,
);
