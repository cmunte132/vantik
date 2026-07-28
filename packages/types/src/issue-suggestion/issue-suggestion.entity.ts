import { Issue } from '../issue';

export class IssueSuggestion {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  deleted: Date | null;
  issueId: string;
  suggestedLabelIds: string[];
  suggestedAssigneeId: string | null;
  /**
   * The modules the LLM proposes. A suggestion never reaches
   * `Issue.moduleIds` on its own — a person accepts it first.
   */
  suggestedModuleIds: string[];
  /** Holds the modules a person dismissed, under `dismissedModuleIds`. */
  metadata: any | null;
  issue?: Issue | null;
}
