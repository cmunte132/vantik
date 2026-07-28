/**
 * A Product is a thing that the company ships. A Product holds no code and no
 * issues. It groups the modules.
 */
export class Product {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  deleted: Date | null;

  name: string;
  /** A short name, for example "cloud" or "docs". */
  key: string;
  description: string | null;
  status: string | null;
  icon: string | null;
  color: string | null;
  leadUserId: string | null;

  workspaceId: string;
}
