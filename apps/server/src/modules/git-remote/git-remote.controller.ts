import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  AddGitRemoteRepositoryDto,
  ConnectGitRemoteDto,
  GitRemoteConnectionIdDto,
  GitRemoteRepositoryIdDto,
} from '@vantikhq/types';

import { AuthGuard } from 'modules/auth/auth.guard';
import { UserId, Workspace } from 'modules/auth/session.decorator';

import { GitRemoteService } from './git-remote.service';

/**
 * The routes of the git remote integration.
 *
 * Each route takes the workspace from the session and never from the body.
 * The service checks that the user is an admin of that workspace before each
 * write. No route returns a token.
 */
@Controller({
  version: '1',
  path: 'git_remote',
})
export class GitRemoteController {
  constructor(private gitRemote: GitRemoteService) {}

  @Get()
  @UseGuards(AuthGuard)
  async list(@Workspace() workspaceId: string) {
    return await this.gitRemote.list(workspaceId);
  }

  @Post()
  @UseGuards(AuthGuard)
  async connect(
    @Workspace() workspaceId: string,
    @UserId() userId: string,
    @Body() body: ConnectGitRemoteDto,
  ) {
    return await this.gitRemote.connect(workspaceId, userId, body);
  }

  @Delete(':connectionId')
  @UseGuards(AuthGuard)
  async disconnect(
    @Workspace() workspaceId: string,
    @UserId() userId: string,
    @Param() params: GitRemoteConnectionIdDto,
  ) {
    await this.gitRemote.disconnect(workspaceId, userId, params.connectionId);

    return { removed: true };
  }

  @Get(':connectionId/available')
  @UseGuards(AuthGuard)
  async available(
    @Workspace() workspaceId: string,
    @Param() params: GitRemoteConnectionIdDto,
  ) {
    return await this.gitRemote.available(workspaceId, params.connectionId);
  }

  @Post(':connectionId/repositories')
  @UseGuards(AuthGuard)
  async addRepository(
    @Workspace() workspaceId: string,
    @UserId() userId: string,
    @Param() params: GitRemoteConnectionIdDto,
    @Body() body: AddGitRemoteRepositoryDto,
  ) {
    return await this.gitRemote.addRepository(
      workspaceId,
      userId,
      params.connectionId,
      body,
    );
  }

  @Delete(':connectionId/repositories/:repositoryId')
  @UseGuards(AuthGuard)
  async removeRepository(
    @Workspace() workspaceId: string,
    @UserId() userId: string,
    @Param() params: GitRemoteRepositoryIdDto,
  ) {
    return await this.gitRemote.removeRepository(
      workspaceId,
      userId,
      params.connectionId,
      params.repositoryId,
    );
  }
}
