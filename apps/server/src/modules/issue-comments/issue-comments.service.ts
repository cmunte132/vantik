import { Injectable } from '@nestjs/common';
import {
  ActionTypesEnum,
  CreateIssueCommentDto,
  CreateIssueCommentRequestParamsDto,
  IssueComment,
  IssueCommentRequestParamsDto,
  LinkedComment,
  NotificationEventFrom,
  UpdateIssueCommentDto,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';
import { NotificationsQueue } from 'modules/notifications/notifications.queue';

import {
  convertMarkdownToTiptapJson,
  convertTiptapJsonToMarkdown,
} from 'common/utils/tiptap.utils';

import { IssuesQueue } from 'modules/issues/issues.queue';
import IssuesService from 'modules/issues/issues.service';

@Injectable()
export default class IssueCommentsService {
  constructor(
    private prisma: PrismaService,
    private issuesService: IssuesService,
    private issuesQueue: IssuesQueue,
    private notificationsQueue: NotificationsQueue,
  ) {}

  async getIssueComment(issueCommentParams: IssueCommentRequestParamsDto) {
    const issueComment = await this.prisma.issueComment.findUnique({
      where: { id: issueCommentParams.issueCommentId },
      include: { parent: true, linkedComment: true },
    });

    const bodyMarkdown = convertTiptapJsonToMarkdown(issueComment.body);

    return { bodyMarkdown, ...issueComment };
  }

  async getReplyComments(issueCommentParams: IssueCommentRequestParamsDto) {
    // Get all comments that have this comment as their parent
    const replyComments = await this.prisma.issueComment.findMany({
      where: {
        parentId: issueCommentParams.issueCommentId,
        deleted: null,
      },
      include: {
        parent: true,
        linkedComment: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    // Convert body to markdown for each reply
    const repliesWithMarkdown = replyComments.map((comment) => ({
      ...comment,
      bodyMarkdown: convertTiptapJsonToMarkdown(comment.body),
    }));

    return repliesWithMarkdown;
  }

  async createIssueComment(
    issueRequestParams: CreateIssueCommentRequestParamsDto,
    userId: string,
    commentData: CreateIssueCommentDto,
  ): Promise<IssueComment> {
    const { linkCommentMetadata, body, bodyMarkdown, ...otherCommentData } =
      commentData;

    const createdByInfo = {
      userId,
      updatedById: userId,
    };

    let updatedBody = body;
    if (!body && bodyMarkdown) {
      updatedBody = JSON.stringify(convertMarkdownToTiptapJson(bodyMarkdown));
    }

    const issueComment = await this.prisma.issueComment.create({
      data: {
        body: updatedBody,
        ...otherCommentData,
        ...createdByInfo,
        issueId: issueRequestParams.issueId,
        ...(linkCommentMetadata && {
          linkedComment: { create: linkCommentMetadata },
        }),
      },
      include: {
        issue: { include: { team: true } },
        parent: true,
      },
    });
    const mentionedUserIds = extractMentionedUserIds(updatedBody);
    const subscribersToAdd = [...new Set([userId, ...mentionedUserIds])];

    this.issuesService.updateSubscribers(
      issueRequestParams.issueId,
      subscribersToAdd,
    );

    this.notificationsQueue.deliver({
      event: ActionTypesEnum.ON_CREATE,
      notificationType: NotificationEventFrom.NewComment,
      notificationData: {
        subscriberIds: issueComment.issue.subscriberIds,
        issueCommentId: issueComment.id,
        issueId: issueComment.issueId,
        workspaceId: issueComment.issue.team.workspaceId,
        userId,
      },
    });

    // Comments are part of the issue's search document, so the embedding has
    // to be refreshed whenever they change.
    this.issuesQueue.addIssueToVector(issueComment.issue);

    const newBodyMarkdown = convertTiptapJsonToMarkdown(issueComment.body);
    return { ...issueComment, bodyMarkdown: newBodyMarkdown };
  }

  async updateIssueComment(
    issueCommentParams: IssueCommentRequestParamsDto,
    commentData: UpdateIssueCommentDto,
  ): Promise<IssueComment> {
    const { body, bodyMarkdown, ...otherCommentData } = commentData;
    let updatedBody = body;

    if (!body && bodyMarkdown) {
      updatedBody = JSON.stringify(convertMarkdownToTiptapJson(bodyMarkdown));
    }

    const issueComment = await this.prisma.issueComment.update({
      where: {
        id: issueCommentParams.issueCommentId,
      },
      data: { body: updatedBody, ...otherCommentData },
      include: {
        issue: { include: { team: true } },
        parent: true,
      },
    });

    this.issuesQueue.addIssueToVector(issueComment.issue);

    const newBodyMarkdown = convertTiptapJsonToMarkdown(issueComment.body);
    return { ...issueComment, bodyMarkdown: newBodyMarkdown };
  }

  async deleteIssueComment(
    issueCommentParams: IssueCommentRequestParamsDto,
  ): Promise<IssueComment> {
    const issueComment = await this.prisma.issueComment.update({
      where: {
        id: issueCommentParams.issueCommentId,
      },
      data: {
        deleted: new Date().toISOString(),
      },
      include: {
        issue: { include: { team: true } },
        parent: true,
      },
    });

    this.issuesQueue.addIssueToVector(issueComment.issue);

    return issueComment;
  }

  async getLinkedCommentBySource(sourceId: string): Promise<LinkedComment> {
    const linkedComment = await this.prisma.linkedComment.findFirst({
      where: { sourceId },
      include: { comment: true },
    });

    if (!linkedComment?.comment) {
      return linkedComment;
    }

    return {
      ...linkedComment,
      comment: {
        ...linkedComment.comment,
        bodyMarkdown: convertTiptapJsonToMarkdown(linkedComment.comment.body),
      },
    };
  }

  async createLinkedComment(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createLinkedCommentInput: any,
  ): Promise<LinkedComment> {
    return this.prisma.linkedComment.create({
      data: createLinkedCommentInput,
    });
  }
}

function extractMentionedUserIds(body: string): string[] {
  try {
    const parsedBody = JSON.parse(body);
    const mentions: string[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const traverse = (node: any) => {
      if (node.type === 'mention' && node.attrs?.id) {
        mentions.push(node.attrs.id);
      }
      if (node.content && Array.isArray(node.content)) {
        node.content.forEach(traverse);
      }
    };

    traverse(parsedBody);
    return mentions;
  } catch (error) {
    console.error('Error parsing body for mentions:', error);
    return [];
  }
}
