/**
 * The second axis beside Team.
 *
 * A Product groups modules and holds no code. A Module is usually one
 * repository. A Capability is what the software does, and it names the modules
 * that hold its code.
 */

export interface ProductType {
  id: string;
  createdAt: string;
  updatedAt: string;

  name: string;
  /** A short name, for example "cloud" or "docs". */
  key: string;
  description?: string | null;
  status?: string | null;
  icon?: string | null;
  color?: string | null;
  leadUserId?: string | null;

  workspaceId: string;
}

export interface ModuleType {
  id: string;
  createdAt: string;
  updatedAt: string;

  name: string;
  key: string;
  description?: string | null;
  status?: string | null;
  icon?: string | null;
  color?: string | null;
  leadUserId?: string | null;

  /**
   * Exactly one of these two holds a value. A team owns a module of internal
   * tools, and a product owns a module that ships to customers.
   */
  ownerTeamId?: string | null;
  ownerProductId?: string | null;

  /** Secondary links. They carry no authority, and either list can be empty. */
  linkedTeamIds: string[];
  linkedProductIds: string[];

  workspaceId: string;
}

export interface CapabilityType {
  id: string;
  createdAt: string;
  updatedAt: string;

  name: string;
  description?: string | null;
  /** planned, active, live, or deprecated. */
  status?: string | null;

  /** The modules that hold the code. An empty list means nobody built it yet. */
  moduleIds: string[];

  workspaceId: string;
}
