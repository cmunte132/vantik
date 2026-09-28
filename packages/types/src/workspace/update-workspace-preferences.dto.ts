import { IsObject, IsOptional } from 'class-validator';

/**
 * What a workspace's settings may change in its preferences, which the server
 * merges one level deep into `Workspace.preferences`.
 *
 * A key has to be declared here to arrive at all: the request pipe drops what
 * a DTO does not declare. While this class was empty, the agent settings page
 * saved nothing, and said nothing about it.
 */
export class UpdateWorkspacePreferencesDto {
  /**
   * Agent run defaults: executor, repo, model, phases and limits. Free-form
   * here because the server's `workspaceAgentDefaults` reads it back field by
   * field and drops whatever it does not recognise.
   */
  @IsOptional()
  @IsObject()
  agentRuns?: Record<string, unknown>;

  /**
   * Knowledge settings: holdoutRate, autoTriage, auditRate and the rest of
   * the keys the server's `knowledgeSettings` names. Free-form for the same
   * reason: it reads each field back, and one it cannot read falls to the
   * deployment's setting.
   */
  @IsOptional()
  @IsObject()
  knowledge?: Record<string, unknown>;
}
