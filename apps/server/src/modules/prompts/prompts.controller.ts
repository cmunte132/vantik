import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Prompt } from '@vantikhq/types';

import { AuthGuard } from 'modules/auth/auth.guard';
import { UserId, Workspace } from 'modules/auth/session.decorator';

import { PromptInput } from './prompts.interface';
import PromptsService from './prompts.service';

/**
 * Note: `PromptsModule` is not registered in `app.module.ts`, so none of these
 * routes are currently reachable — a request to /v1/prompts returns 404. The
 * workspace scoping below is still correct-by-construction so that registering
 * the module later does not reintroduce a cross-tenant read and write.
 */
@Controller({
  version: '1',
  path: 'prompts',
})
export class PromptsController {
  constructor(private promptsService: PromptsService) {}

  @Get()
  @UseGuards(AuthGuard)
  async getAllPrompts(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Query('workspaceId') requestedWorkspaceId?: string,
  ): Promise<Prompt[]> {
    return await this.promptsService.getAllPrompts(
      sessionWorkspaceId,
      userId,
      requestedWorkspaceId,
    );
  }

  @Post()
  @UseGuards(AuthGuard)
  async createPrompt(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Body() promptInput: PromptInput,
    @Query('workspaceId') requestedWorkspaceId?: string,
  ): Promise<Prompt> {
    return await this.promptsService.createPrompt(
      sessionWorkspaceId,
      userId,
      promptInput,
      requestedWorkspaceId,
    );
  }

  @Post(':promptId')
  @UseGuards(AuthGuard)
  async getPrompt(@Param('promptId') promptId: string): Promise<Prompt> {
    return await this.promptsService.getPrompt(promptId);
  }

  @Post(':promptId')
  @UseGuards(AuthGuard)
  async updatePrompt(
    @Param('promptId') promptId: string,
    @Body() promptInput: PromptInput,
  ): Promise<Prompt> {
    return await this.promptsService.updatePrompt(promptId, promptInput);
  }

  @Delete(':promptId')
  @UseGuards(AuthGuard)
  async deletePrompt(@Param('promptId') promptId: string): Promise<Prompt> {
    return await this.promptsService.deletePrompt(promptId);
  }
}
