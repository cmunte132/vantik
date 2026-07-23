export interface ProjectMilestoneType {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  description?: string;
  endDate?: string;
  projectId: string;
}

export interface ProjectType {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  status: string | null;
  leadUserId?: string;
  teams: string[];
  workspaceId: string;
}
