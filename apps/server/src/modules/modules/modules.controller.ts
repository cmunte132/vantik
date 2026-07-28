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
  CreateModuleDto,
  CreateModuleRepoDto,
  ModuleRepoRequestParamsDto,
  ModuleRequestParamsDto,
  UpdateModuleDto,
  UpdateModuleRepoDto,
} from '@vantikhq/types';

import { AuthGuard } from 'modules/auth/auth.guard';
import { Workspace } from 'modules/auth/session.decorator';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';

import { ModulesService } from './modules.service';

@Controller({
  version: '1',
  path: 'modules',
})
export class ModulesController {
  constructor(private modules: ModulesService) {}

  @Get()
  @UseGuards(AuthGuard)
  async getModules(@Workspace() workspace: string) {
    return await this.modules.getModules(workspace);
  }

  // Create is guarded too, unlike the product route: the body names an owning
  // team or product and any number of linked ones, and each of those ids has to
  // belong to the caller's workspace.
  @Post()
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async createModule(
    @Workspace() workspace: string,
    @Body() moduleData: CreateModuleDto,
  ) {
    return await this.modules.createModule(moduleData, workspace);
  }

  // The repository routes come before the bare `:moduleId` routes. Nest matches
  // in the order it is given, so `POST :moduleId/repos` declared after
  // `POST :moduleId` would never be reached.
  @Get(':moduleId/repos')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async getModuleRepos(@Param() moduleParams: ModuleRequestParamsDto) {
    return await this.modules.getModuleRepos(moduleParams.moduleId);
  }

  @Post(':moduleId/repos')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async createModuleRepo(
    @Param() moduleParams: ModuleRequestParamsDto,
    @Body() repoData: CreateModuleRepoDto,
  ) {
    return await this.modules.createModuleRepo(
      repoData,
      moduleParams.moduleId,
    );
  }

  @Post(':moduleId/repos/:moduleRepoId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async updateModuleRepo(
    @Param() repoParams: ModuleRepoRequestParamsDto,
    @Body() repoData: UpdateModuleRepoDto,
  ) {
    return await this.modules.updateModuleRepo(
      repoData,
      repoParams.moduleRepoId,
    );
  }

  @Delete(':moduleId/repos/:moduleRepoId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async deleteModuleRepo(@Param() repoParams: ModuleRepoRequestParamsDto) {
    return await this.modules.deleteModuleRepo(repoParams.moduleRepoId);
  }

  @Post(':moduleId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async updateModule(
    @Param() moduleParams: ModuleRequestParamsDto,
    @Body() moduleData: UpdateModuleDto,
  ) {
    return await this.modules.updateModule(moduleData, moduleParams.moduleId);
  }

  @Delete(':moduleId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async deleteModule(@Param() moduleParams: ModuleRequestParamsDto) {
    return await this.modules.deleteModule(moduleParams.moduleId);
  }
}
