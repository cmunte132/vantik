import { Attachment } from '../attachment';
import { UserType } from '../conversation-history';
import { IntegrationAccount } from '../integration-account';
import { Role } from '../invite';
import { Issue } from '../issue';
import { Template } from '../template';
import { UsersOnWorkspaces } from '../users-on-workspaces';

export class User {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  email: string;
  fullname: string | null;
  username: string;
  /** Person, agent or system. Role is per workspace; this is per account. */
  type: UserType;
  initialSetupComplete: boolean;
  anonymousDataCollection: boolean;
  usersOnWorkspaces?: UsersOnWorkspaces[];
  template?: Template[];
  createdBy?: Issue[];
  integrationAccount?: IntegrationAccount[];
  attachment?: Attachment[];
}

export class PublicUser {
  id: string;
  username: string;
  fullname: string;
  email: string;
  role: Role;
  type: UserType;
}
