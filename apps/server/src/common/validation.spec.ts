/**
 * What a handler receives once the global pipe has run.
 *
 * `whitelist` is only safe when every DTO declares what its clients send. A
 * property the pipe cannot see is not rejected, it quietly arrives as
 * undefined, so each DTO that relied on the pipe ignoring it is pinned here.
 */
import type { ArgumentMetadata, Type } from '@nestjs/common';

import { BadRequestException } from '@nestjs/common';
import {
  AgentRunFilterDto,
  CodeDto,
  CodeDtoWithWorkspace,
  CreateIssueDto,
  CreatePatDto,
  CreateTemplateDto,
  GetIssuesQueryDto,
  GetUsersDto,
  IntegrationDefinitionIdDto,
  TemplateCategoryEnum,
  UpdateTemplateDto,
} from '@vantikhq/types';

import { OAuthBodyInterface } from 'modules/oauth-callback/oauth-callback.interface';
import {
  CreateViewsRequestBody,
  UpdateViewsRequestBody,
} from 'modules/views/views.interface';

import { validationPipe } from './validation';

function run(
  metatype: Type<unknown>,
  value: unknown,
  type: ArgumentMetadata['type'] = 'body',
) {
  return validationPipe().transform(value, { type, metatype });
}

describe('the global validation pipe', () => {
  it('drops what the DTO does not declare', async () => {
    // A body the service spreads straight into `prisma.template.create`.
    await expect(
      run(CreateTemplateDto, {
        name: 'Bug',
        category: TemplateCategoryEnum.ISSUE,
        templateData: { title: 'x' },
        workspaceId: 'someone-elses-workspace',
        deleted: '2026-01-01T00:00:00.000Z',
      }),
    ).resolves.toEqual({
      name: 'Bug',
      category: TemplateCategoryEnum.ISSUE,
      templateData: { title: 'x' },
    });
  });

  it('still rejects what the DTO forbids', async () => {
    await expect(run(GetUsersDto, { userIds: 'user-1' })).rejects.toThrow(
      BadRequestException,
    );
  });

  describe('keeps a view’s filters', () => {
    // A map keyed by field name. Validated as a nested class, every key was
    // stripped and the view saved with no filters.
    const filters = {
      status: { filterType: 'IS', value: ['todo'] },
      assignee: { filterType: 'IS_NOT', value: ['user-1'] },
    };

    it('on create', async () => {
      await expect(
        run(CreateViewsRequestBody, { name: 'Mine', filters }),
      ).resolves.toMatchObject({ filters });
    });

    it('on update', async () => {
      await expect(
        run(UpdateViewsRequestBody, { filters }),
      ).resolves.toMatchObject({ filters });
    });
  });

  describe('keeps every field of a DTO that had no decorators', () => {
    const cases: Array<
      [string, Type<unknown>, Record<string, unknown>, ArgumentMetadata['type']]
    > = [
      ['CreatePatDto', CreatePatDto, { name: 'CI token' }, 'body'],
      ['CodeDto', CodeDto, { code: '123456' }, 'body'],
      [
        'CodeDtoWithWorkspace',
        CodeDtoWithWorkspace,
        { code: '123456', workspaceId: 'ws-1' },
        'body',
      ],
      ['GetUsersDto', GetUsersDto, { userIds: ['user-1', 'user-2'] }, 'body'],
      [
        'IntegrationDefinitionIdDto',
        IntegrationDefinitionIdDto,
        { integrationDefinitionId: 'def-1' },
        'param',
      ],
      [
        'UpdateTemplateDto',
        UpdateTemplateDto,
        { name: 'Bug', templateData: { title: 'x', labelIds: ['l-1'] } },
        'body',
      ],
      [
        'OAuthBodyInterface',
        OAuthBodyInterface,
        {
          redirectURL: 'http://localhost:3000/settings',
          personal: true,
          integrationDefinitionId: 'def-1',
        },
        'body',
      ],
    ];

    it.each(cases)('%s', async (_name, metatype, value, type) => {
      await expect(run(metatype, value, type)).resolves.toEqual(value);
    });

    it('keeps the cycle an issue is created in', async () => {
      // The cycle overview sends it. Undeclared, it would be dropped, and the
      // issue created outside the cycle it was added from.
      await expect(
        run(CreateIssueDto, {
          title: 'Fix login',
          stateId: 'state-1',
          teamId: 'team-1',
          cycleId: 'cycle-1',
        }),
      ).resolves.toMatchObject({ cycleId: 'cycle-1' });
    });

    it('lets an update leave the template data alone', async () => {
      await expect(run(UpdateTemplateDto, { name: 'Bug' })).resolves.toEqual({
        name: 'Bug',
      });
    });
  });

  describe('hands the handler the transformed value', () => {
    it('as a number, for a numeric query parameter', async () => {
      await expect(
        run(AgentRunFilterDto, { page: '2', perPage: '25' }, 'query'),
      ).resolves.toMatchObject({ page: 2, perPage: 25 });
    });

    it('as a list, for comma-separated issue ids', async () => {
      // Before, the handler got the raw string and passed it to Prisma's `in`.
      await expect(
        run(GetIssuesQueryDto, { issueIds: 'issue-1, issue-2' }, 'query'),
      ).resolves.toEqual({ issueIds: ['issue-1', 'issue-2'] });
    });
  });
});
