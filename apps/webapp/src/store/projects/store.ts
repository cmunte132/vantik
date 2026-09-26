import {
  type IAnyStateTreeNode,
  type Instance,
  types,
  flow,
} from 'mobx-state-tree';

import type { ProjectType } from 'common/types';

import { vantikDatabase } from 'store/database';

import { Project } from './models';

export const ProjectsStore: IAnyStateTreeNode = types
  .model({
    projects: types.array(Project),
    workspaceId: types.union(types.string, types.undefined),
  })
  .actions((self) => {
    const update = (project: ProjectType, id: string) => {
      const indexToUpdate = self.projects.findIndex((obj) => obj.id === id);

      if (indexToUpdate !== -1) {
        // Update the object at the found index with the new data
        self.projects[indexToUpdate] = {
          ...self.projects[indexToUpdate],
          ...project,
          // TODO fix the any and have a type with Issuetype
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
      } else {
        self.projects.push(project);
      }
    };
    const deleteById = (id: string) => {
      const indexToDelete = self.projects.findIndex((obj) => obj.id === id);

      if (indexToDelete !== -1) {
        self.projects.splice(indexToDelete, 1);
      }
    };

    const load = flow(function* () {
      const projects = yield vantikDatabase.projects.toArray();

      self.projects = projects;
    });

    return { update, deleteById, load };
  })
  .views((self) => ({
    getProjectWithId(id: string) {
      return self.projects.find((project) => project.id === id);
    },

    // A project that names no team is workspace-wide, as the server has it,
    // so it belongs to every team. Read as "no team", it could not be picked
    // from any issue, and a team's board grouped by project left its issues
    // out of every column.
    getProjectWithTeamId(teamId: string) {
      return self.projects.filter(
        (project) =>
          project.teams.length === 0 || project.teams.includes(teamId),
      );
    },

    hasProjects(teamId: string) {
      return self.projects.some(
        (project) =>
          project.teams.length === 0 || project.teams.includes(teamId),
      );
    },

    get getProjects() {
      return self.projects;
    },
  }));

export type ProjectsStoreType = Instance<typeof ProjectsStore>;
