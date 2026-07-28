import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

/**
 * Where the code of a module is.
 *
 * The server holds these rows and does not replicate them. The module page asks
 * for them in a plain request.
 */
export class ModuleRepo {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  deleted: Date | null;

  moduleId: string;
  integrationAccountId: string | null;
  externalRepoId: string;
  fullName: string;

  /** Empty means the module is all of the repository. */
  pathPrefixes: string[];
  bidirectional: boolean;
  isDefault: boolean;
}

export class CreateModuleRepoDto {
  @IsString()
  externalRepoId: string;

  @IsString()
  fullName: string;

  @IsOptional()
  @IsString()
  integrationAccountId?: string;

  /**
   * The paths in the repository that belong to this module. Leave it empty when
   * the module is all of the repository.
   */
  @IsOptional()
  @IsArray()
  pathPrefixes?: string[];

  @IsOptional()
  @IsBoolean()
  bidirectional?: boolean;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateModuleRepoDto {
  @IsOptional()
  @IsArray()
  pathPrefixes?: string[];

  @IsOptional()
  @IsBoolean()
  bidirectional?: boolean;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class ModuleRepoRequestParamsDto {
  @IsString()
  moduleId: string;

  @IsString()
  moduleRepoId: string;
}
