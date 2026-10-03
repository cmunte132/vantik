import { Workspace } from '../workspace/workspace.entity';

/**
 * A prompt asks for a tier, not a named model. Which model serves each tier is
 * deployment configuration: LLM_MODEL for the default tier, and
 * LLM_MODEL_DECISIONS, when set, for the decisions the server acts on.
 */
export const LLMTiers = ['default', 'decisions'] as const;

export type LLMTier = (typeof LLMTiers)[number];

export class Prompt {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  deleted: Date | null;
  name: string;
  prompt: string;

  model: LLMTier;
  workspace?: Workspace;
  workspaceId: string;
}
