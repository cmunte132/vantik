import { Injectable } from '@nestjs/common';
import { AIStreamResponse, GetAIRequestDTO } from '@vantikhq/types';
import {
  generateText,
  type ModelMessage,
  streamText,
  type UserModelMessage,
} from 'ai';
import { PrismaService } from 'nestjs-prisma';

import { LoggerService } from 'modules/logger/logger.service';

import { getLanguageModel, resolveModel } from './llm-provider';

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
        (text: string, model: string) => {
          this.createRecord(
            text,
            userMessages,
            model,
            reqBody.model,
            workspaceId,
          );
        },
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
    onFinish: (text: string, model: string) => void,
  ) {
    const { role, modelId: finalModel } = resolveModel(model);
    const modelInstance = getLanguageModel(finalModel);

    this.logger.info({
      message: `Sending request for role '${role}' with model: ${finalModel}`,
      where: `AIRequestsService.makeModelCall`,
    });

    if (stream) {
      return await streamText({
        model: modelInstance,
        messages,
        onFinish: async ({ text }) => {
          onFinish(text, finalModel);
        },
      });
    }

    const { text } = await generateText({
      model: modelInstance,
      messages,
    });

    onFinish(text, finalModel);

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
