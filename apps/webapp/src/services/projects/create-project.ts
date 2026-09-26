import { createProject } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

export const useCreateProjectMutation = mutationHook(createProject);
