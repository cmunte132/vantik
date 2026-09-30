import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';

import { LoggerService } from 'modules/logger/logger.service';

import IssuesAIService from './issues-ai.service';
import { IssueWithRelations } from './issues.interface';

@Processor('issues')
export class IssuesProcessor {
  constructor(private issuesAiservice: IssuesAIService) {}
  private readonly logger: LoggerService = new LoggerService('IssueProcessor');

  @Process('handleTriageIssue')
  async handleTriageIssue(
    job: Job<{ issue: IssueWithRelations; isDeleted: boolean }>,
  ) {
    const { issue, isDeleted } = job.data;
    this.logger.info({
      message: `Handling triage for issue ${issue.id}`,
      where: `IssuesProcessor.handleTriageIssue`,
    });

    if (isDeleted) {
      this.logger.info({
        message: `Issue ${issue.id} moved out of Triage, removing suggestions`,
        where: `IssuesProcessor.handleTriageIssue`,
      });
      return await this.issuesAiservice.deleteIssueSuggestion(issue.id);
    }

    this.logger.info({
      message: `Finding similar issues for issue ${issue.id}`,
      where: `IssuesProcessor.handleTriageIssue`,
    });
    await this.issuesAiservice.similarIssueSuggestion(
      issue.team.workspaceId,
      issue.id,
    );

    this.logger.info({
      message: `Generating issue suggestions for issue ${issue.id}`,
      where: `IssuesProcessor.handleTriageIssue`,
    });
    return await this.issuesAiservice.issueSuggestions(issue);
  }
}
