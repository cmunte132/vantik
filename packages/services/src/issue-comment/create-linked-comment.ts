import { CreateLinkedIssueCommentDto, LinkedComment } from '@vantikhq/types';
import axios from 'axios';

export async function createLinkedIssueComment(
  createLinkedIssueDto: CreateLinkedIssueCommentDto,
): Promise<LinkedComment> {
  const response = await axios.post(
    `/api/v1/issue_comments/linked_comment`,
    createLinkedIssueDto,
  );

  return response.data;
}
