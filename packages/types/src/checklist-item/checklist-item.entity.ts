import { Issue } from '../issue';

// A single acceptance criterion on an issue's Definition of Done. Kept as its
// own row (rather than a JSON blob on the issue) so each item syncs, reorders,
// and carries its own completion provenance independently.
export class ChecklistItem {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  deleted: Date | null;

  body: string;
  completed: boolean;
  // Where the item sits in the list. Nullable so older rows sort by createdAt
  // until they are next reordered.
  sortOrder: number | null;

  // Who ticked it and when, so completion reads as work done by someone rather
  // than an anonymous flag flip.
  completedAt: Date | null;
  completedById: string | null;

  issue?: Issue;
  issueId: string;

  createdById: string | null;
  updatedById: string | null;
}
