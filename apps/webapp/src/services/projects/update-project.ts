import { updateProject } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

export const useUpdateProjectMutation = mutationHook(updateProject);
