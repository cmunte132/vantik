import { createProjectMilestone } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

export const useCreateProjectMilestoneMutation = mutationHook(
  createProjectMilestone,
);
