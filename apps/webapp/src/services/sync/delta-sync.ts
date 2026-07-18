import type { BootstrapResponse } from 'common/types';

import { ajaxGet } from 'services/utils';

export function getDeltaRecords(
  workspaceId: string,
  modelNames: string[],
  lastSequenceId: string,
  userId: string,
): Promise<BootstrapResponse> {
  return ajaxGet({
    url: `/api/v1/sync_actions/delta`,
    query: {
      workspaceId,
      userId,
      modelNames: modelNames.join(','),
      lastSequenceId,
    },
  });
}
