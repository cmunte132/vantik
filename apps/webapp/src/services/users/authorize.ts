import type { CodeDtoWithWorkspace } from '@vantikhq/types';

import { ajaxPost, mutationHook } from 'services/utils';

export function authorizeCode(codeBody: CodeDtoWithWorkspace) {
  return ajaxPost({ url: `/api/v1/users/authorization`, data: codeBody });
}

export const useAuthorizeMutation = mutationHook(authorizeCode);
