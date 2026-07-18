import type { ActionConfig } from '@vantikhq/types';

import { getActionInputs } from '@vantikhq/services';
import { type UseQueryResult, useQuery } from '@tanstack/react-query';

import { type XHRErrorResponse } from 'services/utils';

/**
 * Query Key for Get user.
 */
const GetActionInputs = 'getActionInputs';

export function useGetActionInputsQuery(
  slug: string,
  workspaceId: string,
): UseQueryResult<ActionConfig['inputs'], XHRErrorResponse> {
  return useQuery({
    queryKey: [GetActionInputs, slug, workspaceId],
    queryFn: () => getActionInputs({ slug, workspaceId }),
    retry: 1,
    staleTime: 10000,

    // Frequency of Change would be Low
    refetchOnWindowFocus: false
  });
}
