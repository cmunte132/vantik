import { deleteIssueComment } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

export const useDeleteCommentMutation = mutationHook(deleteIssueComment);
