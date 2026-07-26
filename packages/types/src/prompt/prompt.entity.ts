import { Workspace } from '../workspace/workspace.entity';

/**
 * A prompt asks for a class of model, not a named one. Which model serves each
 * role is deployment configuration (LLM_MODEL_FAST / LLM_MODEL_SMART).
 */
export const LLMRoles = ['fast', 'smart'] as const;

export type LLMRole = (typeof LLMRoles)[number];

export class Prompt {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  deleted: Date | null;
  name: string;
  prompt: string;

  model: string;
  workspace?: Workspace;
  workspaceId: string;
}
