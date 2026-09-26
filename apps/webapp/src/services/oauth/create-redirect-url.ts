import { ajaxPost, mutationHook } from 'services/utils';

export interface CreateRedirectURLParams {
  workspaceId?: string;
  integrationDefinitionId: string;
  redirectURL: string;
  personal?: boolean;
}

export interface RedirectURLResponse {
  status: number;
  redirectURL: string;
}

export function createRedirectURL(
  params: CreateRedirectURLParams,
): Promise<RedirectURLResponse> {
  return ajaxPost({
    url: '/api/v1/oauth',
    data: params,
  });
}

export const useCreateRedirectURLMutation = mutationHook(createRedirectURL);
