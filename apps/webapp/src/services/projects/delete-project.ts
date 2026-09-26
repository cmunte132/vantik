import { deleteProject } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

export const useDeleteProjectMutation = mutationHook(deleteProject);
