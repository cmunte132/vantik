// import { sort } from 'fast-sort';
import { Timeline, TimelineItem } from '@vantikhq/ui/components/timeline';
import { sort } from 'fast-sort';
import { observer } from 'mobx-react-lite';
import React from 'react';

import type { User } from 'common/types';
import type { IssueCommentType } from 'common/types';

import { useIssueData } from 'hooks/issues';
import { useUsersData } from 'hooks/users';

import { useContextStore } from 'store/global-context-provider';

import { RunCard } from 'modules/agent-runs/run-card';

import { CommentActivity } from './comment-activity';
import { IssueComment } from './issue-comment';

export const CommentsActivity = observer(() => {
  const issue = useIssueData();
  const { commentsStore, agentRunsStore } = useContextStore();

  const { users, isLoading } = useUsersData(true);

  function getUserData(userId: string) {
    return users.find((user: User) => user.id === userId);
  }

  function getChildComments(issueCommentId: string) {
    return sortedComments.filter(
      (comment: IssueCommentType) => comment.parentId === issueCommentId,
    );
  }

  const sortedComments = React.useMemo(() => {
    const comments = commentsStore.getComments(issue.id) as IssueCommentType[];

    return sort(comments).asc((comment) =>
      new Date(comment.createdAt).getTime(),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commentsStore.comments.length, issue]);

  /**
   * Comments and agent runs, interleaved by when they happened.
   *
   * A run is in the feed from the moment it starts, so a live one is watchable
   * here rather than only after it reports. Its own summary comment is dropped:
   * the server posts one so that mail, the API and MCP see the handback in
   * words, but here the card says the same thing with the buttons attached, and
   * two of them would be one story told twice.
   */
  const entries = React.useMemo(() => {
    const runs = agentRunsStore
      .getRunsForIssue(issue.id)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((run: any) => ({ kind: 'run' as const, at: run.createdAt, run }));

    const reported = new Set(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runs.map((entry: any) => entry.run.id),
    );

    const comments = sortedComments
      .filter((comment: IssueCommentType) => !comment.parentId)
      .filter(
        (comment: IssueCommentType) =>
          !reported.has(agentRunIdOf(comment.sourceMetadata)),
      )
      .map((comment: IssueCommentType) => ({
        kind: 'comment' as const,
        at: comment.createdAt,
        comment,
      }));

    return sort([...runs, ...comments]).asc((entry) =>
      new Date(entry.at).getTime(),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedComments, agentRunsStore.agentRuns.length, issue]);

  if (isLoading) {
    return null;
  }

  return (
    <div className="my-2 w-full flex flex-col gap-4">
      <Timeline>
        {entries.map((entry, index: number) =>
          entry.kind === 'run' ? (
            <TimelineItem
              className="w-full"
              key={entry.run.id}
              hasMore={index > 0}
            >
              <RunCard
                run={entry.run}
                user={getUserData(entry.run.agentUserId)}
              />
            </TimelineItem>
          ) : (
            <CommentActivity
              issueId={issue.id}
              commentId={entry.comment.id}
              key={entry.comment.id}
              hasMore={index > 0}
              user={getUserData(entry.comment.userId)}
              childComments={getChildComments(entry.comment.id)}
              allowReply
              getUserData={getUserData}
            />
          ),
        )}
      </Timeline>
      <IssueComment />
    </div>
  );
});

/** The run a comment reports on, when it is an agent handback. */
function agentRunIdOf(sourceMetadata?: string | null): string | undefined {
  if (!sourceMetadata) {
    return undefined;
  }

  try {
    return JSON.parse(sourceMetadata)?.agentRunId;
  } catch {
    // Metadata this client cannot read must not take the comment with it.
    return undefined;
  }
}
