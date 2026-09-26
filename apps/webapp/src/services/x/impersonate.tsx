import { ajaxPost, mutationHook } from 'services/utils';

export interface ImpersonateParams {
  userId: string;
  key: string;
}

export function impersonate(data: ImpersonateParams) {
  return ajaxPost({
    url: `/api/v1/users/impersonate`,
    data,
  });
}

export const useImpersonateMutation = mutationHook(impersonate);
