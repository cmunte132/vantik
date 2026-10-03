import { Injectable } from '@nestjs/common';
import { AIStreamResponse, GetAIRequestDTO } from '@vantikhq/types';
import { type ModelMessage, type UserModelMessage } from 'ai';
import { PrismaService } from 'nestjs-prisma';

import { LoggerService } from 'modules/logger/logger.service';

import { generateModelText, streamModelText } from './model-call';

@Injectable()
export default class AIRequestsService {
  private readonly logger: LoggerService = new LoggerService('RequestsService');
  constructor(private prisma: PrismaService) {}

  async getLLMRequest(
    reqBody: GetAIRequestDTO,
    workspaceId: string,
  ): Promise<string> {
    return (await this.LLMRequestStream(reqBody, workspaceId, false)) as string;
  }

  async getLLMRequestStream(
    reqBody: GetAIRequestDTO,
    workspaceId: string,
  ): Promise<AIStreamResponse> {
    return (await this.LLMRequestStream(
      reqBody,
      workspaceId,
      true,
    )) as AIStreamResponse;
  }

  async LLMRequestStream(
    reqBody: GetAIRequestDTO,
    workspaceId: string,
    stream: boolean = true,
  ) {
    const messages = reqBody.messages;
    const userMessages = reqBody.messages.filter(
      (message: ModelMessage) => message.role === 'user',
    );
    const model = reqBody.llmModel;
    this.logger.info({
      message: `Received request with model: ${model}`,
      payload: { userMessages },
      where: `AIRequestsService.LLMRequestStream`,
    });

    try {
      return await this.makeModelCall(
        stream,
        model,
        messages,
        (text: string, model: string) =>
          this.createRecord(
            text,
            userMessages,
            model,
            reqBody.model,
            workspaceId,
          ).catch((error) =>
            this.logger.error({
              message: `Could not save the AI request: ${error.message}`,
              where: `AIRequestsService.createRecord`,
              error,
            }),
          ),
        reqBody.model,
      );
    } catch (error) {
      this.logger.error({
        message: `Error in LLMRequestStream: ${error.message}`,
        where: `AIRequestsService.LLMRequestStream`,
        error,
      });
      throw error;
    }
  }

  async makeModelCall(
    stream: boolean,
    model: string,
    messages: ModelMessage[],
    onFinish: (text: string, model: string) => void | Promise<void>,
    // The feature that asked, for example `IssueTitle`. The log line names it.
    purpose?: string,
  ) {
    purpose = purpose || 'ai-request';

    if (stream) {
      return streamModelText({ purpose, tier: model, messages }, onFinish);
    }

    const { text, model: finalModel } = await generateModelText({
      purpose,
      tier: model,
      messages,
    });

    await onFinish(text, finalModel);

    return text;
  }

  async createRecord(
    message: string,
    userMessages: UserModelMessage[],
    model: string,
    serviceModel: string,
    workspaceId: string,
  ) {
    this.logger.info({
      message: `Saving request and response to database`,
      where: `AIRequestsService.createRecord`,
    });
    await this.prisma.aIRequest.create({
      data: {
        data: JSON.stringify(userMessages),
        modelName: serviceModel,
        workspaceId,
        response: message,
        successful: true,
        llmModel: model,
      },
    });
  }
}
