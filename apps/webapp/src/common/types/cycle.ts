export interface CycleType {
  id: string;
  createdAt: string;
  updatedAt: string;

  name: string;
  description: string;
  teamId: string;

  number: number;

  startDate: string;
  endDate: string;

  /** Absent on rows cached before this field was synced; see the store model. */
  status?: string;
  closedAt?: string | null;

  preferences?: string;
}
