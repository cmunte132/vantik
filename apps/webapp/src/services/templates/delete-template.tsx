import { deleteTemplate } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

export const useDeleteTemplateMutation = mutationHook(deleteTemplate);
