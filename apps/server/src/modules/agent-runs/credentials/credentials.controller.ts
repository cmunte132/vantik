import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';

import { AdminGuard } from 'modules/users/admin.guard';
import { AuthGuard } from 'modules/auth/auth.guard';
import { UserId, Workspace } from 'modules/auth/session.decorator';

import {
  CredentialsService,
  type CredentialKind,
} from './credentials.service';

const KINDS = ['MODEL_API_KEY', 'GIT_TOKEN'] as const;

export class PutCredentialDto {
  @IsIn(KINDS)
  kind: CredentialKind;

  @IsString()
  secret: string;

  /** For a model key: which OpenAI-compatible endpoint it belongs to. */
  @IsOptional()
  @IsString()
  baseUrl?: string;
}

export class CredentialParamsDto {
  @IsIn(KINDS)
  kind: CredentialKind;
}

/**
 * Workspace credentials for hosted execution.
 *
 * Write-only, and admin-gated. There is deliberately no endpoint that returns
 * a secret: every response here carries a masked handle, and a "read it back
 * to confirm" route is precisely how a credential store becomes a credential
 * leak.
 */
@Controller({
  version: '1',
  path: 'workspace_credentials',
})
export class CredentialsController {
  constructor(private credentials: CredentialsService) {}

  /** Masked handles only — kind, a four-character hint, and when it changed. */
  @Get()
  @UseGuards(AuthGuard, AdminGuard)
  async list(@Workspace() workspace: string) {
    return this.credentials.list(workspace);
  }

  @Post()
  @UseGuards(AuthGuard, AdminGuard)
  async put(
    @Workspace() workspace: string,
    @UserId() userId: string,
    @Body() body: PutCredentialDto,
  ) {
    return this.credentials.put({
      workspaceId: workspace,
      kind: body.kind,
      secret: body.secret,
      baseUrl: body.baseUrl,
      createdById: userId,
    });
  }

  @Delete(':kind')
  @UseGuards(AuthGuard, AdminGuard)
  async remove(
    @Workspace() workspace: string,
    @Param() params: CredentialParamsDto,
  ) {
    await this.credentials.remove(workspace, params.kind);
    return { removed: params.kind };
  }
}
