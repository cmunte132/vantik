import { IsArray, IsString } from 'class-validator';

export class AddLocalRepositoryDto {
  @IsString()
  path: string;
}

export class LocalRepositoryIdDto {
  @IsString()
  repositoryId: string;
}

export class SetGitIssuesDto {
  @IsArray()
  @IsString({ each: true })
  teamIds: string[];
}
