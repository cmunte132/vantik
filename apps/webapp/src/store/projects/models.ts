import { types } from 'mobx-state-tree';

export const ProjectMilestone = types.model('ProjectMilestone', {
  id: types.string,
  createdAt: types.string,
  updatedAt: types.string,
  name: types.string,
  description: types.union(types.string, types.null),
  endDate: types.union(types.string, types.null),
  projectId: types.string,
});

export const Project = types.model('Project', {
  id: types.string,
  createdAt: types.string,
  updatedAt: types.string,
  name: types.string,
  description: types.union(types.string, types.null),
  // Nullable on the server, so it has to be nullable here: a single project
  // with a null status used to fail the type check for the whole
  // `projects` array, leaving the store — and the UI — with no projects at all.
  status: types.union(types.string, types.null),
  startDate: types.union(types.string, types.null),
  endDate: types.union(types.string, types.null),
  leadUserId: types.union(types.string, types.null),
  teams: types.array(types.string),
  workspaceId: types.string,
});
