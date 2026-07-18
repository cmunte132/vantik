import type { BootstrapResponse } from 'common/types';

import { ajaxGet } from 'services/utils';

export function getBootstrapRecords(
  workspaceId: string,
  modelNames: string[],
  userId: string,
): Promise<BootstrapResponse> {
  return ajaxGet({
    url: `/api/v1/sync_actions/bootstrap`,
    query: {
      workspaceId,
      userId,
      modelNames: modelNames.join(','),
    },
  });
}
