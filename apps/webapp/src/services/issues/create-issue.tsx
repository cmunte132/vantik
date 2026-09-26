import type { IssueType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

export interface CreateIssueParams {
  title?: string;
  description: string;
  // Used while creating new issue
  descriptionString?: string;
  priority?: number;

  labelIds?: string[];
  stateId: string;
  assigneeId?: string;
  teamId: string;
  parentId?: string;
  projectId?: string;
  projectMilestoneId?: string;
  cycleId?: string;

  // Need when creating from the description
  start?: number;
  end?: number;
}

// `start` and `end` stay behind: they say where in a description the issue was
// written, which the caller reads back from the mutation's variables to put a
// link there. The server has no use for them.
/* eslint-disable @typescript-eslint/no-unused-vars */
export function createIssue({
  teamId,
  start,
  end,
  ...otherParams
}: CreateIssueParams): Promise<IssueType> {
  /* eslint-enable @typescript-eslint/no-unused-vars */
  return ajaxPost({
    url: `/api/v1/issues`,
    data: {
      ...otherParams,
      teamId,
      sortOrder: 0,
      estimate: 0,
      subscriberIds: [],
    },
  });
}

export const useCreateIssueMutation = mutationHook(createIssue);
