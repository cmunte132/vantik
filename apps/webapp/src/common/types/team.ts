export type TeamTypeInterface = 'engineering' | 'support';

export enum TeamTypeEnum {
  ENGINEERING = 'engineering',
  SUPPORT = 'support',
}
export type CyclesMode = 'auto' | 'manual';

export interface TeamPreferences {
  cyclesEnabled?: boolean;
  /**
   * Widened to `string` because it arrives through the MobX model, which cannot
   * express the union. Absent on every team that enabled cycles before the mode
   * existed; readers treat that as manual — see `cyclesModeForTeam` in the
   * teams store, the one place the fallback is spelled out.
   */
  cyclesMode?: string;
  cyclesFrequency?: number;
  upcomingCycles?: number;
  teamType?: string;
}

export interface TeamType {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  identifier: string;
  workspaceId: string;
  currentCycle?: number;
  preferences: TeamPreferences;
}

export interface WorkflowType {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  position: number;
  description?: string;
  color: string;
  category: string;
  teamId: string;

  // For processed purpose
  ids?: string[];
}
