import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import { AuthGuard } from 'modules/auth/auth.guard';
import { UserId, Workspace } from 'modules/auth/session.decorator';

import {
  AddLocalRepositoryDto,
  LocalRepositoryIdDto,
} from './local-repo.interface';
import { LocalRepoService } from './local-repo.service';

/**
 * The routes of the local repository integration.
 *
 * Each route takes the workspace from the session and never from the body. A
 * member of one workspace cannot read or change the repositories of another.
 *
 * Adding and removing need an admin of that workspace, which the service proves
 * from the membership row. A path here names a directory on the machine that
 * runs the server, so allowing every member to add one hands every member a way
 * to ask what exists on that disk.
 */
@Controller({
  version: '1',
  path: 'local_repo',
})
export class LocalRepoController {
  constructor(private localRepo: LocalRepoService) {}

  @Get()
  @UseGuards(AuthGuard)
  async list(@Workspace() workspaceId: string) {
    return await this.localRepo.list(workspaceId);
  }

  @Post()
  @UseGuards(AuthGuard)
  async add(
    @Workspace() workspaceId: string,
    @UserId() userId: string,
    @Body() body: AddLocalRepositoryDto,
  ) {
    return await this.localRepo.add(workspaceId, userId, body.path);
  }

  /**
   * The folders inside one repository that a module can claim.
   *
   * This route comes before the bare `:repositoryId` routes. Nest matches in
   * the order it is given.
   */
  @Get(':repositoryId/folders')
  @UseGuards(AuthGuard)
  async folders(
    @Workspace() workspaceId: string,
    @Param() params: LocalRepositoryIdDto,
  ) {
    return await this.localRepo.folders(workspaceId, params.repositoryId);
  }

  @Delete(':repositoryId')
  @UseGuards(AuthGuard)
  async remove(
    @Workspace() workspaceId: string,
    @UserId() userId: string,
    @Param() params: LocalRepositoryIdDto,
  ) {
    return await this.localRepo.remove(
      workspaceId,
      userId,
      params.repositoryId,
    );
  }
}
