import { IsIn, IsOptional, IsString } from 'class-validator';

import { GIT_REMOTE_KINDS, type GitRemoteKind } from './git-remote.entity';

export class ConnectGitRemoteDto {
  @IsIn(GIT_REMOTE_KINDS)
  kind: GitRemoteKind;

  @IsString()
  baseUrl: string;

  /** The user name that git sends with the token. */
  @IsOptional()
  @IsString()
  username?: string;

  /**
   * An access token for the host. Without a token, the server can fetch a
   * public repository but it cannot push.
   */
  @IsOptional()
  @IsString()
  token?: string;
}

export class GitRemoteConnectionIdDto {
  @IsString()
  connectionId: string;
}

export class AddGitRemoteRepositoryDto {
  /**
   * The path of the repository on the host, for example `owner/name`. A
   * Forgejo, Gitea or GitLab connection needs this field.
   */
  @IsOptional()
  @IsString()
  fullName?: string;

  /** The clone address. A generic connection needs this field. */
  @IsOptional()
  @IsString()
  cloneUrl?: string;
}

export class GitRemoteRepositoryIdDto {
  @IsString()
  connectionId: string;

  @IsString()
  repositoryId: string;
}
