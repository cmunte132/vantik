import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CreateIssueDto,
  CreateIssueRelationDto,
  IssueRelationEnum,
  TeamRequestParamsDto,
} from '@vantikhq/types';
import { Response } from 'express';
import { PrismaService } from 'nestjs-prisma';

import { assertTeamsVisible, visibleTeamIds } from 'common/team-access';
import { convertTiptapJsonToText } from 'common/utils/tiptap.utils';

import AIRequestsService from 'modules/ai-requests/ai-requests.services';
import IssueRelationService from 'modules/issue-relation/issue-relation.service';
import { LoggerService } from 'modules/logger/logger.service';
import { VectorService } from 'modules/vector/vector.service';

import {
  dismissedModuleIds,
  getAiFilter,
  getIssueTitle,
  getSuggestedLabels,
  getSuggestedModules,
  getSummary,
  withDismissedModule,
} from './issues-ai.utils';
import {
  AIInput,
  DescriptionInput,
  FilterInput,
  IssueWithRelations,
  SubIssueInput,
} from './issues.interface';

@Injectable()
export default class IssuesAIService {
  private readonly logger: LoggerService = new LoggerService('IssueAIService');

  constructor(
    private prisma: PrismaService,
    private vectorService: VectorService,
    private aiRequestsService: AIRequestsService,
    private issueRelationService: IssueRelationService,
  ) {}

  /**
   * Generates suggestions for labels and assignees based on the issue description.
   * @param teamRequestParams The team request parameters.
   * @param suggestionsInput The input for generating suggestions, including the issue description and workspace ID.
   * @returns An object containing the suggested labels and assignees.
   */
  async suggestions(
    teamRequestParams: TeamRequestParamsDto,
    suggestionsInput: AIInput,
  ) {
    // Check if the description is empty or falsy
    if (!suggestionsInput.description) {
      return { labels: [], assignees: [] };
    }

    // Find labels based on the workspace ID and team ID
    const labels = await this.prisma.label.findMany({
      where: {
        OR: [
          { workspaceId: suggestionsInput.workspaceId },
          { teamId: teamRequestParams.teamId },
        ],
      },
    });

    // Get suggested labels and similar issues concurrently
    const [labelsSuggested, similarIssues] = await Promise.all([
      getSuggestedLabels(
        this.prisma,
        this.aiRequestsService,
        labels.map((label) => label.name),
        suggestionsInput.description,
        suggestionsInput.workspaceId,
      ),
      this.vectorService.searchEmbeddings(
        suggestionsInput.workspaceId,
        suggestionsInput.description,
        10,
        0.2,
      ),
    ]);

    // Find suggested labels based on the suggested label names
    const suggestedLabels = await this.prisma.label.findMany({
      where: {
        name: { in: labelsSuggested.split(/,\s*/), mode: 'insensitive' },
        OR: [
          { workspaceId: suggestionsInput.workspaceId },
          { teamId: teamRequestParams.teamId },
        ],
      },
      select: { id: true, name: true, color: true },
    });

    // Extract unique assignee IDs from similar issues
    const assigneeIds = new Set(
      similarIssues
        .filter((issue) => issue.assigneeId)
        .map((issue) => issue.assigneeId),
    );

    // Map assignee IDs to assignee objects with scores
    const assignees = Array.from(assigneeIds).map((assigneeId) => ({
      id: assigneeId,
      score:
        similarIssues.find((issue) => issue.assigneeId === assigneeId)
          ?.relevanceScore ?? 0,
    }));

    return { labels: suggestedLabels, assignees };
  }

  /**
   * This method suggests labels and modules for an issue.
   *
   * The two are guarded on their own. An issue that has labels but no module
   * still gets a module suggested, which is the ordinary case: a person who
   * labels an issue by hand has said nothing about the code it changes.
   *
   * Nothing here writes to the issue. Both lists land on `IssueSuggestion`, and
   * a person accepts or dismisses them.
   */
  async issueSuggestions(issue: IssueWithRelations) {
    const wantsLabels = issue.labelIds.length === 0;
    const wantsModules = (issue.moduleIds ?? []).length === 0;

    if (!wantsLabels && !wantsModules) {
      this.logger.info({
        message: `Issue ${issue.id} already has labels and modules, skipping suggestions.`,
        where: `IssuesAIService.issueSuggestions`,
      });
      return undefined;
    }

    const suggestedModuleIds = wantsModules
      ? await this.suggestModules(issue)
      : [];

    if (!wantsLabels) {
      // The labels are a person's already. Only the modules are written, and
      // the label suggestion the row holds is left as it was.
      return await this.saveSuggestion(issue.id, { suggestedModuleIds });
    }

    // Fetch labels for the workspace or team, and similar issues
    const [labels, similarIssues] = await Promise.all([
      this.prisma.label.findMany({
        where: {
          OR: [
            { workspaceId: issue.team.workspaceId },
            { teamId: issue.teamId },
          ],
        },
      }),
      this.prisma.issueRelation.findMany({
        where: {
          relatedIssueId: issue.id,
          type: IssueRelationEnum.SIMILAR,
          deleted: null,
        },
        include: {
          issue: true,
        },
      }),
    ]);

    this.logger.info({
      message: `Fetched ${labels.length} labels and ${similarIssues.length} similar issues for issue ${issue.id}.`,
      where: `IssuesAIService.issueSuggestions`,
    });

    let labelIds: string[];

    // If similar issues exist, use their label IDs
    if (similarIssues.length > 0) {
      labelIds = similarIssues.flatMap(
        (similarIssue) => similarIssue.issue.labelIds,
      );
      this.logger.info({
        message: `Using label IDs from ${similarIssues.length} similar issues for issue ${issue.id}.`,
        where: `IssuesAIService.issueSuggestions`,
      });
    } else {
      // Otherwise, get suggested labels from OpenAI based on the issue description
      this.logger.info({
        message: `Fetching suggested labels from OpenAI for issue ${issue.id}.`,
        where: `IssuesAIService.issueSuggestions`,
      });
      const gptLabels = await getSuggestedLabels(
        this.prisma,
        this.aiRequestsService,
        labels.map((label) => label.name),
        issue.description,
        issue.team.workspaceId,
      );

      // Find the suggested labels in the database
      const suggestedLabels = await this.prisma.label.findMany({
        where: {
          name: { in: gptLabels.split(/,\s*/), mode: 'insensitive' },
          OR: [
            { workspaceId: issue.team.workspaceId },
            { teamId: issue.teamId },
          ],
        },
        select: { id: true },
      });

      // Extract the label IDs from the suggested labels
      labelIds = suggestedLabels.map((label) => label.id);
    }

    return await this.saveSuggestion(issue.id, {
      suggestedLabelIds: labelIds,
      suggestedModuleIds,
    });
  }

  /**
   * This method asks the model which modules an issue would change.
   *
   * A module that a person dismissed on this issue is removed from the answer.
   * The classifier has no memory, so it names the same module on every run, and
   * without this the chip a person closed comes back.
   */
  private async suggestModules(issue: IssueWithRelations): Promise<string[]> {
    const [modules, existing] = await Promise.all([
      this.prisma.module.findMany({
        where: { workspaceId: issue.team.workspaceId, deleted: null },
        select: { id: true, name: true, description: true },
      }),
      this.prisma.issueSuggestion.findUnique({
        where: { issueId: issue.id },
        select: { metadata: true },
      }),
    ]);

    const suggested = await getSuggestedModules(
      this.prisma,
      this.aiRequestsService,
      modules,
      convertTiptapJsonToText(issue.description),
      issue.team.workspaceId,
    );

    const dismissed = new Set(dismissedModuleIds(existing?.metadata));

    return suggested.filter((moduleId) => !dismissed.has(moduleId));
  }

  /**
   * This method writes the suggestion, and leaves alone what it was not given.
   *
   * The two halves are written on their own runs, so an update that carried
   * both would clear the labels each time only the modules were asked for.
   */
  private async saveSuggestion(
    issueId: string,
    values: { suggestedLabelIds?: string[]; suggestedModuleIds?: string[] },
  ) {
    const labelIds = values.suggestedLabelIds
      ? [...new Set(values.suggestedLabelIds)]
      : undefined;
    const moduleIds = values.suggestedModuleIds
      ? [...new Set(values.suggestedModuleIds)]
      : undefined;

    const suggestion = await this.prisma.issueSuggestion.upsert({
      where: { issueId },
      create: {
        issueId,
        issue: { connect: { id: issueId } },
        suggestedLabelIds: labelIds ?? [],
        suggestedModuleIds: moduleIds ?? [],
      },
      update: {
        ...(labelIds ? { suggestedLabelIds: labelIds } : {}),
        ...(moduleIds ? { suggestedModuleIds: moduleIds } : {}),
      },
    });

    this.logger.info({
      message: `Upserted issue suggestion for issue ${issueId}: ${suggestion.suggestedLabelIds.length} label(s), ${suggestion.suggestedModuleIds.length} module(s).`,
      where: `IssuesAIService.issueSuggestions`,
    });

    return suggestion;
  }

  /**
   * This method promotes a suggested module to a module of the issue.
   *
   * Accepting is the act of a person, and it moves the module to the top tier
   * of confidence: the pull request router adds to `Issue.moduleIds` and never
   * removes from it, so nothing overwrites this later.
   *
   * The module leaves the suggestion, because it is no longer a suggestion.
   */
  async acceptModuleSuggestion(issueId: string, moduleId: string) {
    const [issue, suggestion] = await Promise.all([
      this.prisma.issue.findFirst({
        where: { id: issueId, deleted: null },
        select: { id: true, moduleIds: true },
      }),
      this.prisma.issueSuggestion.findUnique({
        where: { issueId },
        select: { suggestedModuleIds: true },
      }),
    ]);

    if (!issue) {
      return undefined;
    }

    await this.prisma.issue.update({
      where: { id: issueId },
      data: { moduleIds: [...new Set([...issue.moduleIds, moduleId])] },
    });

    if (suggestion) {
      await this.prisma.issueSuggestion.update({
        where: { issueId },
        data: {
          suggestedModuleIds: suggestion.suggestedModuleIds.filter(
            (id) => id !== moduleId,
          ),
        },
      });
    }

    this.logger.info({
      message: `A person accepted module ${moduleId} on issue ${issueId}`,
      where: `IssuesAIService.acceptModuleSuggestion`,
    });

    return { issueId, moduleId, accepted: true };
  }

  /**
   * This method removes a suggested module and remembers that it was removed.
   *
   * The issue itself is not touched. The classifier has no memory and names the
   * same module on the next run, so the dismissal is recorded in the metadata
   * of the suggestion and read back before the next answer is written.
   */
  async dismissModuleSuggestion(issueId: string, moduleId: string) {
    const suggestion = await this.prisma.issueSuggestion.findUnique({
      where: { issueId },
      select: { suggestedModuleIds: true, metadata: true },
    });

    if (!suggestion) {
      return undefined;
    }

    await this.prisma.issueSuggestion.update({
      where: { issueId },
      data: {
        suggestedModuleIds: suggestion.suggestedModuleIds.filter(
          (id) => id !== moduleId,
        ),
        // Prisma types a Json column as its own union rather than as an
        // object, so the shape built here is cast at the boundary.
        metadata: withDismissedModule(
          suggestion.metadata,
          moduleId,
        ) as Prisma.InputJsonValue,
      },
    });

    this.logger.info({
      message: `A person dismissed module ${moduleId} on issue ${issueId}`,
      where: `IssuesAIService.dismissModuleSuggestion`,
    });

    return { issueId, moduleId, dismissed: true };
  }

  /**
   * Deletes an issue suggestion by marking it as deleted.
   * @param issueId The ID of the issue associated with the suggestion.
   * @returns The updated issue suggestion with the deleted timestamp.
   */
  async deleteIssueSuggestion(issueId: string) {
    return await this.prisma.issueSuggestion.update({
      where: { issueId },
      data: { deleted: new Date().toISOString() },
    });
  }

  /**
   * Generates similar issue suggestions for a given issue in a workspace.
   * @param workspaceId The ID of the workspace.
   * @param issueId The ID of the issue to find similar issues for.
   * @returns An array of similar issues.
   */
  async similarIssueSuggestion(workspaceId: string, issueId: string) {
    // Find similar issues using the vector service
    const similarIssues = await this.vectorService.similarIssues(
      workspaceId,
      issueId,
    );

    // Create issue relations for each similar issue
    similarIssues.map(async (similarIssue) => {
      const relationData: CreateIssueRelationDto = {
        type: IssueRelationEnum.SIMILAR,
        issueId,
        relatedIssueId: similarIssue.id,
      };

      // Create the issue relation using the issue relation service
      await this.issueRelationService.createIssueRelation(null, relationData);
    });

    return similarIssues;
  }

  /**
   * Generates similar issue suggestions for a given issue in a workspace.
   * @param workspaceId The ID of the workspace.
   * @param issueId The ID of the issue to find similar issues for.
   * @returns An array of similar issues.
   */
  async summarizeIssue(issueId: string) {
    // Fetch issue comments and their replies for the given issueId
    const issueComments = await this.prisma.issueComment.findMany({
      where: { issueId, deleted: null, parentId: null },
      orderBy: { createdAt: 'asc' },
      include: {
        replies: {
          where: { deleted: null },
          orderBy: { createdAt: 'asc' },
        },
        issue: { include: { team: true } },
      },
    });

    // If no comments are found, return undefined
    if (issueComments.length < 1) {
      return undefined;
    }

    // Fetch team users for the workspace and team associated with the issue
    const teamUsers = await this.prisma.usersOnWorkspaces.findMany({
      where: {
        workspaceId: issueComments[0].issue.team.workspaceId,
        teamIds: {
          hasSome: [issueComments[0].issue.teamId],
        },
      },
      include: { user: true },
    });

    // Create a mapping of user IDs to their full names
    const formattedTeamUsers: Record<string, string> = teamUsers.reduce(
      (acc: Record<string, string>, member) => {
        acc[member.user.id] = member.user.fullname;
        return acc;
      },
      {},
    );

    // Format comments and replies with user names
    const formattedComments = issueComments.map((comment) => {
      const sourceMetadata = comment.sourceMetadata as Record<string, string>;
      const userName =
        formattedTeamUsers[comment.userId] ||
        sourceMetadata?.userDisplayName ||
        null;
      const message = convertTiptapJsonToText(comment.body);
      const formattedReplies = comment.replies.map((reply) => {
        const replySourceMetadata = reply.sourceMetadata as Record<
          string,
          string
        >;
        const replyUserName =
          formattedTeamUsers[comment.userId] ||
          replySourceMetadata?.userDisplayName ||
          null;
        const replyMessage = convertTiptapJsonToText(reply.body);
        return `  Reply - ${replyUserName}: ${replyMessage}`;
      });
      return `Message - ${userName}: ${message}\n${formattedReplies.join('\n')}`;
    });

    // Generate a summary of the formatted comments using OpenAI
    const rawSummary = await getSummary(
      this.prisma,
      this.aiRequestsService,
      formattedComments.join('\n'),
      issueComments[0].issue.team.workspaceId,
    );

    // Extract bullet points from the raw summary using regex
    const bulletPointRegex = /- (.*)/g;
    const bulletPoints =
      rawSummary
        .match(bulletPointRegex)
        ?.map((point) => point.replace(/^- /, '').trim()) || [];

    // Return the extracted bullet points
    return bulletPoints;
  }

  /**
   * Generates an AI filter based on the provided team request parameters and filter input.
   * @param teamRequestParams - The team request parameters.
   * @param filterInput - The filter input containing the text and workspace ID.
   * @returns The generated AI filter.
   */
  async aiFilters(
    filterInput: FilterInput,
    userId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<Record<string, any>> {
    // A team is a visibility boundary, so the raw material this filter is
    // built from has to respect it. What comes back is a filter object rather
    // than issue content, which is why this was left alone by ENG-79 — but the
    // labels another team invented and the names of the people on it are still
    // that team's, and a suggestion list is a perfectly good way to read them.
    const visible = await visibleTeamIds(
      this.prisma,
      userId,
      filterInput.workspaceId,
    );

    // A named team is proved rather than trusted: the id arrives in the request
    // body, so without this the boundary is whatever the caller typed. Not
    // found rather than forbidden, matching the rest of team-access — a hidden
    // team and an imaginary one have to look the same, or the error says which
    // teams exist.
    if (filterInput.teamId) {
      await assertTeamsVisible([filterInput.teamId], visible);
    }

    // With no team named, every team the caller belongs to. Previously every
    // team in the workspace.
    const teamIds = filterInput.teamId ? [filterInput.teamId] : visible;

    // A label with no team is workspace-wide and reaches every member; one
    // that names a team is that team's. The workspace is pinned as an `AND`
    // rather than sitting inside the `OR`: as an alternative it made every
    // workspace-scoped label match, and the second branch was `{}` whenever no
    // team was named — an empty condition, which matches every label on the
    // server rather than none.
    const labels = await this.prisma.label.findMany({
      where: {
        workspaceId: filterInput.workspaceId,
        deleted: null,
        OR: [{ teamId: null }, { teamId: { in: teamIds } }],
      },
    });

    // Extract label names from the retrieved labels
    const labelNames = labels.map((label) => label.name);
    this.logger.debug({
      message: `Retrieved label names: ${labelNames}`,
      where: `IssuesAIService.aiFilters`,
    });

    // The people on those teams, and the workspace is pinned here too: a bare
    // `hasSome` on team ids is workspace-agnostic, so it would have reached
    // memberships in other workspaces had two of them ever shared a team id.
    const assignee = await this.prisma.usersOnWorkspaces.findMany({
      where: {
        workspaceId: filterInput.workspaceId,
        teamIds: { hasSome: teamIds },
      },
      include: { user: true },
    });

    // Extract assignee names from the retrieved assignees
    const assigneeNames = assignee.map((assignee) => assignee.user.fullname);
    this.logger.debug({
      message: `Retrieved assignee names: ${assigneeNames}`,
      where: `IssuesAIService.aiFilters`,
    });

    // Workflow is team-owned, so it takes the same limit. A workflow's states
    // name how another team works, which is exactly what a boundary is for.
    const workflow = await this.prisma.workflow.findMany({
      where: {
        teamId: { in: teamIds },
        team: { workspaceId: filterInput.workspaceId },
        deleted: null,
      },
    });

    // Extract workflow names from the retrieved workflows
    const workflowNames = workflow.map((workflow) => workflow.name);
    this.logger.debug({
      message: `Retrieved workflow names: ${workflowNames}`,
      where: `IssuesAIService.aiFilters`,
    });

    // Retrieve the workspace based on the team ID
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: filterInput.workspaceId },
    });
    this.logger.debug({
      message: `Retrieved workspace: ${workspace.name}`,
      where: `IssuesAIService.aiFilters`,
    });

    // Call the getAiFilter function with the necessary parameters
    const aiFilter = await getAiFilter(
      this.prisma,
      this.aiRequestsService,
      filterInput.text,
      {
        labelNames,
        assigneeNames,
        workflowNames,
      },
      workspace.id,
    );

    return aiFilter;
  }

  /**
   * Generates sub-issues based on the provided sub-issue input.
   * @param subIssueInput - The input data for generating sub-issues.
   * @returns An array of sub-issues containing title and description.
   */
  async generateSubIssues(
    subIssueInput: SubIssueInput,
  ): Promise<Array<{ title: string; description: string }>> {
    // Retrieve the sub-issue prompt based on the workspace ID
    const subIssuePrompt = await this.prisma.prompt.findFirst({
      where: { name: 'SubIssues', workspaceId: subIssueInput.workspaceId },
    });
    this.logger.debug({
      message: `Retrieved sub-issue prompt: ${JSON.stringify(subIssuePrompt)}`,
      where: `IssuesAIService.generateSubIssues`,
    });

    // Set default label names
    let labelNames: string[] = ['Frontend', 'Backend'];

    // If label IDs are provided, retrieve the corresponding label names
    if (subIssueInput.labelIds.length > 0) {
      labelNames = (
        await this.prisma.label.findMany({
          where: { id: { in: subIssueInput.labelIds } },
          select: { name: true },
        })
      ).map((label) => label.name);
    }
    this.logger.debug({
      message: `Label names for sub-issues: ${labelNames}`,
      where: `IssuesAIService.generateSubIssues`,
    });

    // Generate sub-issues using the AI request service
    const subissues = await this.aiRequestsService.getLLMRequest(
      {
        messages: [
          { role: 'system', content: subIssuePrompt.prompt },
          {
            role: 'user',
            content: `[INPUT] 
          description: ${subIssueInput.description}
          labels: ${JSON.stringify(labelNames)}`,
          },
        ],
        llmModel: subIssuePrompt.model,
        model: 'SubIssues',
      },
      subIssueInput.workspaceId,
    );
    this.logger.debug({
      message: `Generated sub-issues: ${subissues}`,
      where: `IssuesAIService.generateSubIssues`,
    });

    // Extract sub-issue titles using regex
    const regex = /sub_issues:\s*\[(.*?)\]/s;
    const match = subissues.match(regex);

    if (match && match[1]) {
      const subIssueTitles = JSON.parse(`[${match[1]}]`);

      this.logger.debug({
        message: `Extracted sub-issue titles: ${subIssueTitles}`,
        where: `IssuesAIService.generateSubIssues`,
      });

      return subIssueTitles;
    }

    this.logger.debug({
      message: `No sub-issues found in the generated content: ${subissues}`,
      where: `IssuesAIService.generateSubIssues`,
    });
    return [];
  }

  /**
   * Generates an AI-based title for an issue based on the provided AI input.
   * @param aiInput - The AI input containing the issue description and workspace ID.
   * @returns The generated AI-based title for the issue.
   */
  async aiTitle(aiInput: AIInput) {
    return await getIssueTitle(
      this.prisma,
      this.aiRequestsService,
      { description: aiInput.description } as CreateIssueDto,
      aiInput.workspaceId,
    );
  }

  async getDescriptionStream(
    descriptionInput: DescriptionInput,
    response: Response,
  ) {
    try {
      const descriptionPrompt = await this.prisma.prompt.findUnique({
        where: {
          name_workspaceId: {
            name: 'IssueDescription',
            workspaceId: descriptionInput.workspaceId,
          },
        },
      });
      const responseStream = await this.aiRequestsService.getLLMRequestStream(
        {
          messages: [
            { role: 'system', content: descriptionPrompt.prompt },
            {
              role: 'user',
              content: `[INPUT] short_description: ${descriptionInput.description}
                user_input: ${descriptionInput.userInput}`,
            },
          ],
          llmModel: descriptionPrompt.model,
          model: 'IssueDescrptionStream',
        },
        descriptionInput.workspaceId,
      );

      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-cache');
      response.setHeader('Connection', 'keep-alive');

      for await (const textPart of responseStream.textStream) {
        response.write(textPart);
      }

      response.end();
    } catch (error) {
      console.error('Error in callingFunction:', error);
      response.status(500).end('Internal Server Error');
    }
  }
}
