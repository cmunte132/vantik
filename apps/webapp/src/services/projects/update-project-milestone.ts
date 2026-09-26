import { updateProjectMilestone } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

export const useUpdateProjectMilestoneMutation = mutationHook(
  updateProjectMilestone,
);
