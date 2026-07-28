import { IsString } from 'class-validator';

export class AddLocalRepositoryDto {
  @IsString()
  path: string;
}

export class LocalRepositoryIdDto {
  @IsString()
  repositoryId: string;
}
