import { PrismaService } from 'nestjs-prisma';
import type { LLMRole } from '@vantikhq/types';

import { coerceRole } from 'modules/ai-requests/llm-provider';
import { resolveWorkspaceId } from 'common/workspace-access';

import { LoggerService } from 'modules/logger/logger.service';

import { PromptInput } from './prompts.interface';

export default class PromptsService {
  private readonly logger: LoggerService = new LoggerService('PromptsService');
  constructor(private prisma: PrismaService) {}

  private normalizePromptModel<T extends { model: string }>(
    prompt: T,
  ): Omit<T, 'model'> & { model: LLMRole } {
    return { ...prompt, model: coerceRole(prompt.model) };
  }

  async getAllPrompts(
    sessionWorkspaceId: string,
    userId: string,
    requestedWorkspaceId?: string,
  ) {
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      requestedWorkspaceId,
    );

    this.logger.debug({
      message: `Fetching all prompts for this workspace ${workspaceId}`,
      where: `PromptsService.getAllPrompts`,
    });
    const prompts = await this.prisma.prompt.findMany({ where: { workspaceId } });

    return prompts.map((prompt) => this.normalizePromptModel(prompt));
  }

  async createPrompt(
    sessionWorkspaceId: string,
    userId: string,
    promptInput: PromptInput,
    requestedWorkspaceId?: string,
  ) {
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      requestedWorkspaceId,
    );

    const prompt = await this.prisma.prompt.create({
      data: { workspaceId, ...promptInput },
    });

    return this.normalizePromptModel(prompt);
  }

  async updatePrompt(promptId: string, promptInput: PromptInput) {
    const prompt = await this.prisma.prompt.update({
      where: { id: promptId },
      data: { ...promptInput },
    });

    return this.normalizePromptModel(prompt);
  }

  async deletePrompt(promptId: string) {
    const prompt = await this.prisma.prompt.update({
      where: { id: promptId },
      data: { deleted: new Date().toISOString() },
    });

    return this.normalizePromptModel(prompt);
  }

  async getPrompt(promptId: string) {
    const prompt = await this.prisma.prompt.findUnique({ where: { id: promptId } });

    return prompt ? this.normalizePromptModel(prompt) : null;
  }
}
