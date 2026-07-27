import { useMutation } from '@tanstack/react-query';

import type { IssueType, IssueRelationEnum } from 'common/types';

import { ajaxPost } from 'services/utils';

import { vantikDatabase } from 'store/database';
import { useContextStore } from 'store/global-context-provider';
import { queueWrite } from 'store/outbox';
import { isRetryable } from 'store/outbox-drain';

export interface UpdateIssueParams {
  id: string;
  title?: string;
  description?: string;
  priority?: number;

  labelIds?: string[];
  dueDate?: string;
  stateId?: string;
  assigneeId?: string;
  teamId: string;

  parentId?: string;

  cycleId?: string;
  projectId?: string;
  projectMilestoneId?: string;

  issueRelation?: {
    issueId: string;
    relatedIssueId: string;
    type: IssueRelationEnum;
  };
}

export function updateIssue({ id, teamId, ...otherParams }: UpdateIssueParams) {
  const url = `/api/v1/issues/${id}?teamId=${teamId}`;

  // The optimistic update has already been applied to the store by the time
  // this runs, and a network failure is asynchronous — so the rollback in
  // `useUpdateIssueMutation` never fires for one. That left the change on
  // screen with nothing carrying it to the server: the write was simply lost,
  // silently, which is the exact case this buffer exists for.
  return ajaxPost({ url, data: otherParams }).catch(async (
    error,
  ): Promise<undefined> => {
    if (!isRetryable(error)) {
      throw error;
    }

    await queueWrite({ recordId: id, url, data: otherParams });
    await persistLocally(id, otherParams);

    // Resolving rather than rejecting is deliberate: from the user's point of
    // view the change has been accepted, and it has — by this device, which
    // will deliver it. An error toast here would be a lie about work that is
    // not lost.
    return undefined;
  });
}

/**
 * Keeps an unsent change across a reload.
 *
 * The store's optimistic update lives in memory only. Without this, closing
 * the tab shows the old value on the way back while the outbox still holds —
 * and later applies — the new one.
 */
async function persistLocally(
  id: string,
  changes: Record<string, unknown>,
): Promise<void> {
  const cached = await vantikDatabase.issues.get(id);

  if (cached) {
    await vantikDatabase.issues.put({ ...cached, ...changes });
  }
}

interface MutationParams {
  onMutate?: () => void;
  onSuccess?: (data: IssueType) => void;
  onError?: (error: string) => void;
}

export function useUpdateIssueMutation({
  onMutate,
  onSuccess,
  onError,
}: MutationParams) {
  const { issuesStore } = useContextStore();

  const update = ({ id, ...otherParams }: UpdateIssueParams) => {
    const issue = issuesStore.getIssueById(id);

    try {
      issuesStore.updateIssue(otherParams, id);

      return updateIssue({ ...otherParams, id });
    } catch (e) {
      issuesStore.updateIssue(issue, id);
      return undefined;
    }
  };

  const onMutationTriggered = () => {
    onMutate && onMutate();
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onMutationError = (errorResponse: any) => {
    const errorText = errorResponse?.errors?.message || 'Error occurred';

    onError && onError(errorText);
  };

  const onMutationSuccess = (data: IssueType) => {
    onSuccess && onSuccess(data);
  };

  return useMutation({
    mutationFn: update,
    onError: onMutationError,
    onMutate: onMutationTriggered,
    onSuccess: onMutationSuccess,
  });
}
