/**
 * A Module is usually one repository. A Module can also be a path in a
 * repository, or one service.
 *
 * A Module has one owner: a team or a product, and never both. The linked lists
 * hold the other teams and products that use it, and a link gives no authority.
 */
export class Module {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  deleted: Date | null;

  name: string;
  /** A short name, for example "webapp" or "server". */
  key: string;
  description: string | null;
  status: string | null;
  icon: string | null;
  color: string | null;
  leadUserId: string | null;

  ownerTeamId: string | null;
  ownerProductId: string | null;

  linkedTeamIds: string[];
  linkedProductIds: string[];

  /**
   * How an agent run checks work in this module, shaped as
   * `AgentRunVerification`. Null means the run does no checking of its own.
   */
  verification: unknown;

  workspaceId: string;
}
