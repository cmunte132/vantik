import { Injectable, NotFoundException } from '@nestjs/common';
import {
  CreateProjectDto,
  CreateProjectMilestoneDto,
  UpdateProjectDto,
  UpdateProjectMilestoneDto,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import IssuesService from 'modules/issues/issues.service';

// Matches the first entry of the status list the webapp offers.
const DEFAULT_PROJECT_STATUS = 'Backlog';

@Injectable()
export class ProjectsService {
  constructor(
    private prisma: PrismaService,
    private issuesService: IssuesService,
  ) {}

  async getProjects(workspaceId: string) {
    return await this.prisma.project.findMany({
      // Deleting a project is a soft delete, and every other listing in the
      // API excludes those. Without this the list hands back projects that
      // were deleted — which a person can at least recognise, but an agent
      // resolving a name against this list would file work into a dead one.
      where: { workspaceId, deleted: null },
    });
  }

  async createProject(createProjectDto: CreateProjectDto, workspaceId: string) {
    return await this.prisma.project.create({
      data: {
        ...createProjectDto,
        // The dialog always picks one, but an API caller need not, and a
        // project with no status reads as a broken row everywhere downstream.
        status: createProjectDto.status ?? DEFAULT_PROJECT_STATUS,
        workspace: { connect: { id: workspaceId } },
      },
    });
  }

  /**
   * Workspace-scoped on purpose. The route names the project by id alone, so
   * without the workspace in the predicate any caller holding a valid session
   * could rewrite a project belonging to someone else's workspace — the same
   * class of hole ENG-18..ENG-23 closed elsewhere.
   *
   * `updateMany` rather than `update` so a project outside the workspace is a
   * miss, not a match: `update` with a compound `where` still throws Prisma's
   * P2025, but the count here lets us answer with a plain 404 that says nothing
   * about whether the id exists somewhere else.
   */
  async updateProject(
    updateProjectDto: UpdateProjectDto,
    projectId: string,
    workspaceId: string,
  ) {
    const { count } = await this.prisma.project.updateMany({
      where: { id: projectId, workspaceId, deleted: null },
      data: updateProjectDto,
    });

    if (count === 0) {
      throw new NotFoundException({
        message: `Project ${projectId} not found`,
      });
    }

    return await this.prisma.project.findUnique({ where: { id: projectId } });
  }

  async createProjectMilestone(
    createProjectMilestoneDto: CreateProjectMilestoneDto,
    projectId: string,
  ) {
    return await this.prisma.projectMilestone.create({
      data: {
        ...createProjectMilestoneDto,
        project: { connect: { id: projectId } },
      },
    });
  }

  async updateProjectMilestone(
    updateProjectMilestoneDto: UpdateProjectMilestoneDto,
    projectMilestoneId: string,
  ) {
    return await this.prisma.projectMilestone.update({
      where: { id: projectMilestoneId },
      data: updateProjectMilestoneDto,
    });
  }

  async deleteProject(projectId: string) {
    // Get all affected issues before deletion
    const affectedIssues = await this.prisma.issue.findMany({
      where: { projectId },
      include: { team: true },
    });

    // Mark all associated milestones as deleted
    await this.prisma.projectMilestone.updateMany({
      where: { projectId },
      data: { deleted: new Date().toISOString() },
    });

    // Update each affected issue through IssuesService
    await Promise.all(
      affectedIssues.map((issue) =>
        this.issuesService.updateIssueApi(
          { teamId: issue.teamId },
          { projectId: null, projectMilestoneId: null },
          { issueId: issue.id },
          'system',
        ),
      ),
    );

    // Finally mark the project as deleted
    return await this.prisma.project.update({
      where: { id: projectId },
      data: { deleted: new Date().toISOString() },
    });
  }

  async deleteProjectMilestone(projectMilestoneId: string) {
    // Get all affected issues before deletion
    const affectedIssues = await this.prisma.issue.findMany({
      where: { projectMilestoneId },
      include: { team: true },
    });

    // Update each affected issue through IssuesService
    await Promise.all(
      affectedIssues.map((issue) =>
        this.issuesService.updateIssueApi(
          { teamId: issue.teamId },
          { projectMilestoneId: null },
          { issueId: issue.id },
          'system',
        ),
      ),
    );

    // Mark the milestone as deleted
    return await this.prisma.projectMilestone.update({
      where: { id: projectMilestoneId },
      data: { deleted: new Date().toISOString() },
    });
  }
}
