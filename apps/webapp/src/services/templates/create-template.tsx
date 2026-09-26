import { createTemplate } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

export const useCreateTemplateMutation = mutationHook(createTemplate);
