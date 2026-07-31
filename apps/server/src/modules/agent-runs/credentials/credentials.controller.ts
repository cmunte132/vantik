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
import { MODEL_PROVIDERS } from '@vantikhq/types';
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

  /** Which model provider the key belongs to. Absent for a git token. */
  @IsOptional()
  @IsString()
  provider?: string;

  @IsString()
  secret: string;

  /** For a provider whose customers each have their own endpoint. */
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
 *
 * The model catalogue on a handle is not an exception to that. It is what the
 * *provider* said the key can reach, which is public information about the
 * provider's line-up rather than anything about the key.
 */
@Controller({
  version: '1',
  path: 'workspace_credentials',
})
export class CredentialsController {
  constructor(private credentials: CredentialsService) {}

  /**
   * The providers this deployment knows how to talk to.
   *
   * Served rather than duplicated in the client so the settings screen offers
   * exactly the providers the executor can actually run, and a provider added
   * to the table appears in the UI without a second edit. Carries no secret:
   * these are names, hosts and placeholders.
   */
  @Get('providers')
  @UseGuards(AuthGuard, AdminGuard)
  providers() {
    return MODEL_PROVIDERS.map((provider) => ({
      id: provider.id,
      label: provider.label,
      placeholder: provider.placeholder,
      baseUrl: provider.baseUrl
        ? {
            required: provider.baseUrl.required,
            placeholder: provider.baseUrl.placeholder,
          }
        : null,
      discoversModels: Boolean(provider.catalogue),
    }));
  }

  /** Masked handles only — never a secret, and never a ciphertext. */
  @Get()
  @UseGuards(AuthGuard, AdminGuard)
  async list(@Workspace() workspace: string) {
    return this.credentials.list(workspace);
  }

  // There is no `model_access` route. It existed to say "runs work anyway,
  // the deployment supplies a key", which was an answer the list above could
  // not give. Agent runs no longer inherit a host key, so a stored
  // MODEL_API_KEY is exactly the condition, and the list already reports it.

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
      provider: body.provider,
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
    @Query('provider') provider?: string,
  ) {
    await this.credentials.remove(workspace, params.kind, provider ?? '');
    return { removed: provider || params.kind };
  }
}
