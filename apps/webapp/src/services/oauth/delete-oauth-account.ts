import type { IntegrationAccountType } from 'common/types';

import { ajaxDelete, mutationHook } from 'services/utils';

interface IntegrationAccountsParams {
  integrationAccountId: string;
}

export function deleteIntegrationAccount(
  params: IntegrationAccountsParams,
): Promise<IntegrationAccountType> {
  return ajaxDelete({
    url: `/api/v1/integration_account/${params.integrationAccountId}`,
  });
}

export const useDeleteIntegrationAccount = mutationHook(
  deleteIntegrationAccount,
);
