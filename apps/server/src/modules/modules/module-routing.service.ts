import { Injectable } from '@nestjs/common';
import { CodeChangeEvent } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { LoggerService } from 'modules/logger/logger.service';

import {
  mergeModuleIds,
  modulesForChangedPaths,
  type RepoModuleMapping,
} from './module-routing';

/** What a webhook knows about a pull request. */
export interface PullRequestRouting {
  /** The identifier that the provider gives the repository. */
  externalRepoId: string;
  /** The paths of the files that the pull request changed. */
  changedPaths: string[];
  /** The issue that the pull request closes. */
  issueId: string;
}

/**
 * This service writes `Issue.moduleIds` from a pull request.
 *
 * It is the second tier of module assignment. A person is the first tier, and
 * this service never removes what a person set. The LLM is the third tier, and
 * it writes to `IssueSuggestion.suggestedModuleIds` and not here.
 */
@Injectable()
export class ModuleRoutingService {
  private readonly logger: LoggerService = new LoggerService(
    'ModuleRoutingService',
  );

  constructor(private prisma: PrismaService) {}

  /**
   * This method routes one change to code to every issue that it names.
   *
   * A webhook gives the keys that a person wrote, and a person writes a key
   * that no issue holds. So this method reads the issues of the workspace
   * first, and it acts only on the keys that reach one.
   */
  async routeCodeChange(
    change: CodeChangeEvent,
    workspaceId: string,
  ): Promise<void> {
    const issueIds = await this.issuesForKeys(change.issueKeys, workspaceId);

    for (const issueId of issueIds) {
      await this.routePullRequest({
        externalRepoId: change.externalRepoId,
        changedPaths: change.changedPaths,
        issueId,
      });
    }
  }

  /**
   * This method returns the issues of a workspace that a set of keys names.
   *
   * A key is a team identifier and a number, such as `ENG-42`. The query holds
   * the workspace, so a key of another workspace reaches no issue here. This is
   * what makes a loose read of the keys safe: `UTF-8` finds an issue only when
   * the workspace has a team called UTF with an issue number 8.
   */
  private async issuesForKeys(
    keys: string[],
    workspaceId: string,
  ): Promise<string[]> {
    const parsed = keys
      .map((key) => /^([A-Z][A-Z0-9]*)-(\d+)$/.exec(key))
      .filter(Boolean)
      .map((match) => ({
        number: Number(match[2]),
        team: { identifier: match[1], workspaceId },
      }));

    if (parsed.length === 0) {
      return [];
    }

    const issues = await this.prisma.issue.findMany({
      where: { deleted: null, team: { workspaceId }, OR: parsed },
      select: { id: true },
    });

    return issues.map((issue) => issue.id);
  }

  /**
   * This method assigns the modules of a pull request to its issue.
   *
   * It returns the list that the issue holds after the write. A repository that
   * maps to no module leaves the issue as it was, and the method returns the
   * list that the issue already had.
   */
  async routePullRequest(input: PullRequestRouting): Promise<string[]> {
    const { externalRepoId, changedPaths, issueId } = input;

    const issue = await this.prisma.issue.findFirst({
      where: { id: issueId, deleted: null },
      select: {
        id: true,
        moduleIds: true,
        team: { select: { workspaceId: true } },
      },
    });

    if (!issue) {
      this.logger.warn({
        message: `A pull request named issue ${issueId}, which does not exist`,
        where: 'ModuleRoutingService.routePullRequest',
      });

      return [];
    }

    const mappings = await this.mappingsFor(
      externalRepoId,
      issue.team.workspaceId,
    );

    const resolved = modulesForChangedPaths(mappings, changedPaths);

    if (resolved.length === 0) {
      // A repository that nobody mapped, or a pull request that changed only
      // folders which no module claims. Neither is a fault, and neither gives
      // the issue a module.
      return issue.moduleIds;
    }

    const moduleIds = mergeModuleIds(issue.moduleIds, resolved);

    if (moduleIds.length === issue.moduleIds.length) {
      // The pull request found nothing that the issue did not already hold.
      return issue.moduleIds;
    }

    await this.prisma.issue.update({
      where: { id: issue.id },
      data: { moduleIds },
    });

    this.logger.info({
      message: `A pull request gave issue ${issue.id} ${resolved.length} module(s)`,
      where: 'ModuleRoutingService.routePullRequest',
    });

    return moduleIds;
  }

  /**
   * This method returns the modules that a repository maps to.
   *
   * The rows carry the identifier of the repository and not the workspace, and
   * two workspaces can connect the same repository. So the query reads the
   * workspace from the module, and a row of another workspace never reaches the
   * issue of this one.
   */
  private async mappingsFor(
    externalRepoId: string,
    workspaceId: string,
  ): Promise<RepoModuleMapping[]> {
    const rows = await this.prisma.moduleRepo.findMany({
      where: {
        externalRepoId,
        deleted: null,
        module: { workspaceId, deleted: null },
      },
      select: { moduleId: true, pathPrefixes: true },
      orderBy: { createdAt: 'asc' },
    });

    return rows;
  }
}
