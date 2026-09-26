import { Injectable } from '@nestjs/common';
import {
  CreateTemplateDto,
  Template,
  TemplateIdDto,
  UpdateTemplateDto,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

@Injectable()
export default class TemplatesService {
  constructor(private prisma: PrismaService) {}

  async createTemplate(
    userId: string,
    workspaceId: string,
    templateData: CreateTemplateDto,
  ): Promise<Template> {
    const template = await this.prisma.template.create({
      data: {
        ...templateData,
        workspaceId,
        createdById: userId,
      },
    });

    return template;
  }

  async updateTemplate(
    templateRequestIdParams: TemplateIdDto,
    templateData: UpdateTemplateDto,
  ): Promise<Template> {
    return await this.prisma.template.update({
      data: {
        ...templateData,
      },
      where: {
        id: templateRequestIdParams.templateId,
      },
    });
  }

  async deleteTemplate(templateRequestIdParams: TemplateIdDto) {
    return await this.prisma.template.update({
      where: {
        id: templateRequestIdParams.templateId,
      },
      data: {
        deleted: new Date().toISOString(),
      },
    });
  }
}
