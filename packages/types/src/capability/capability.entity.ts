/**
 * A Capability is what the software does. A Module is where the code is.
 *
 * The modules in moduleIds give a Capability its identity. A Capability has no
 * product field. To find the product, read the owner of each Module in the list.
 */
export class Capability {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  deleted: Date | null;

  name: string;
  description: string | null;
  /** planned, active, live, or deprecated. */
  status: string | null;

  moduleIds: string[];

  workspaceId: string;
}
