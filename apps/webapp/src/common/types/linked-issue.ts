export interface LinkedIssueType {
  id: string;
  createdAt: string;
  updatedAt: string;

  url: string;
  sourceId?: string;
  sourceData: string | null;
  issueId: string;
  createdById: string;
}
