import type { Role, UserType } from '@vantikhq/types';

interface Workspace {
  name: string;
  slug: string;
  icon: string;
  status?: string;
  id: string;
  actionsEnabled: boolean;
}

export interface Invite {
  id: string;
  workspaceId: string;
  workspace: Workspace;
  status: 'ACCEPTED' | 'INVITED';
}

export interface User {
  fullname: string;
  email: string;
  id: string;
  username: string;
  workspaces: Workspace[];
  invites: Invite[];
  role: Role;
  /**
   * Person, agent or system. Absent on payloads written before the column
   * existed, so read it through `isAgentUser` rather than comparing directly.
   */
  type?: UserType;
  image?: string;
}
