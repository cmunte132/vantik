import { observer } from 'mobx-react-lite';
import React from 'react';
import ReactTimeAgo from 'react-time-ago';

import { CommentActivity } from 'modules/issues/single-issue/left-side/activity/comments-activity/comment-activity';

import { getPriorities } from 'common/priority';
import {
  NotificationTypeEnum,
  type IssueCommentType,
  type IssueType,
  type NotificationType,
  type User,
  type WorkflowType,
} from 'common/types';
import { getUserIcon } from 'common/user-util';
import { getWorkflowIcon } from 'common/workflow-icons';

import { useTeamWithId } from 'hooks/teams';
import { useTeamWorkflows } from 'hooks/workflows';

import { useContextStore } from 'store/global-context-provider';

import { getActionData } from '../action-data';

interface NotificationUpdateProps {
  notification: NotificationType;
  issue: IssueType;
  getUserData: (userId: string) => User;
}

/**
 * One thing that happened on an issue.
 *
 * The inbox used to draw the whole issue page for a notification, which said
 * nothing about what had changed. Each notification carries the record it is
 * about, so each type is drawn as the update it is: a comment is the comment,
 * a status change is the transition.
 */
export const NotificationUpdate = observer(
  ({ notification, issue, getUserData }: NotificationUpdateProps) => {
    if (notification.type === NotificationTypeEnum.IssueNewComment) {
      return (
        <CommentUpdate
          notification={notification}
          issue={issue}
          getUserData={getUserData}
        />
      );
    }

    return (
      <PropertyUpdate
        notification={notification}
        issue={issue}
        getUserData={getUserData}
      />
    );
  },
);

/**
 * A comment, drawn by the same component the issue page uses.
 *
 * Replies belong here: a comment a person is being told about is the one they
 * are most likely to answer, and sending them to the issue page to do it is
 * the trip this view exists to save.
 */
const CommentUpdate = observer(
  ({ notification, issue, getUserData }: NotificationUpdateProps) => {
    const { commentsStore } = useContextStore();
    const { issueCommentId } = getActionData(notification);

    const comments = commentsStore.getComments(issue.id) as IssueCommentType[];
    const comment = comments.find(
      (item: IssueCommentType) => item.id === issueCommentId,
    );

    // The comment may be deleted, or may not have reached this client. The
    // notification is still true, so it falls back to saying what happened.
    if (!issueCommentId || !comment) {
      return (
        <PropertyUpdate
          notification={notification}
          issue={issue}
          getUserData={getUserData}
        />
      );
    }

    const childComments = comments.filter(
      (item: IssueCommentType) => item.parentId === comment.id,
    );

    return (
      <CommentActivity
        issueId={issue.id}
        commentId={comment.id}
        user={getUserData(comment.userId)}
        childComments={childComments}
        getUserData={getUserData}
        allowReply
      />
    );
  },
);

/**
 * A change to one of the issue's properties, as one line.
 *
 * Everything that is not a comment is a small fact — a status, a priority, a
 * person, a blocking issue — so each is one row rather than a card.
 */
const PropertyUpdate = observer(
  ({ notification, issue, getUserData }: NotificationUpdateProps) => {
    const actor = getUserData(notification.createdById);
    const description = useUpdateDescription(notification, issue);

    return (
      <div className="flex items-start gap-2 py-1 text-sm">
        <div className="flex items-center shrink-0">
          {actor ? (
            getUserIcon(actor)
          ) : (
            <span className="w-5 h-5 rounded-sm bg-grayAlpha-100" />
          )}
        </div>

        <div className="grow min-w-0 flex flex-wrap items-center gap-x-1">
          <span className="font-medium">{actor?.fullname ?? 'Someone'}</span>
          {description}
        </div>

        <div className="shrink-0 text-muted-foreground text-xs pt-0.5">
          <ReactTimeAgo
            date={new Date(notification.createdAt)}
            timeStyle="twitter"
          />
        </div>
      </div>
    );
  },
);

/**
 * The words and the badge for one property change.
 *
 * The record each notification points at may not be on this client — a
 * workflow from a team the person has since left, a relation to an issue they
 * cannot see. Every branch falls back to the plain sentence, so the row says
 * what happened even when it cannot show the thing that happened to.
 */
function useUpdateDescription(
  notification: NotificationType,
  issue: IssueType,
): React.ReactNode {
  const { issueRelationsStore, issuesStore } = useContextStore();
  const actionData = getActionData(notification);
  const priorities = getPriorities();

  const team = useTeamWithId(issue.teamId);
  const workflows = useTeamWorkflows(team?.identifier);

  // Resolved before the switch, not inside the branch that wants it: a hook
  // called from one arm of a switch is a hook that some renders skip.
  const [relation] = actionData.issueRelationId
    ? issueRelationsStore.getRelationFromIds([actionData.issueRelationId])
    : [];
  const blocker = relation
    ? issuesStore.getIssueById(relation.relatedIssueId)
    : undefined;
  const blockerTeam = useTeamWithId(blocker?.teamId);

  switch (notification.type) {
    case NotificationTypeEnum.IssueStatusChanged: {
      const workflow = workflows.find(
        (item: WorkflowType) => item.id === actionData.stateId,
      );

      if (!workflow) {
        return <span>changed the status</span>;
      }

      const Icon = getWorkflowIcon(workflow);

      return (
        <>
          <span>moved this to</span>
          <span className="inline-flex items-center gap-1 font-medium">
            <Icon size={16} />
            {workflow.name}
          </span>
        </>
      );
    }

    case NotificationTypeEnum.IssuePriorityChanged: {
      const priority = priorities[Number(actionData.priorityId)];

      return priority ? (
        <>
          <span>set the priority to</span>
          <span className="font-medium">{priority}</span>
        </>
      ) : (
        <span>changed the priority</span>
      );
    }

    case NotificationTypeEnum.IssueAssigned: {
      return <span>assigned this issue</span>;
    }

    case NotificationTypeEnum.IssueUnAssigned: {
      return <span>took this issue off you</span>;
    }

    case NotificationTypeEnum.IssueBlocks: {
      if (!blocker || !blockerTeam) {
        return <span>marked this blocked</span>;
      }

      return (
        <>
          <span>marked this blocked by</span>
          <span className="font-medium">
            {`${blockerTeam.identifier}-${blocker.number}`}
          </span>
        </>
      );
    }
  }

  return <span>updated this issue</span>;
}
