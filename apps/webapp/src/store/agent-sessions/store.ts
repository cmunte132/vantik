import {
  type IAnyStateTreeNode,
  type Instance,
  types,
  flow,
} from 'mobx-state-tree';

import { vantikDatabase } from 'store/database';

import { AgentSessionArray } from './models';

/**
 * Agent sessions, from every harness and channel.
 *
 * Loaded workspace-wide like the runs, because a hosted run and a terminal
 * session on the same issue are read from one list.
 */
export const AgentSessionsStore: IAnyStateTreeNode = types
  .model({
    agentSessions: AgentSessionArray,
  })
  .actions((self) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const update = (agentSession: any, id: string) => {
      const index = self.agentSessions.findIndex(
        (session) => session.id === id,
      );

      if (index !== -1) {
        self.agentSessions[index] = {
          ...self.agentSessions[index],
          ...agentSession,
        };
      } else {
        self.agentSessions.push(agentSession);
      }
    };

    const deleteById = (id: string) => {
      const index = self.agentSessions.findIndex(
        (session) => session.id === id,
      );
      if (index !== -1) {
        self.agentSessions.splice(index, 1);
      }
    };

    const load = flow(function* () {
      const sessions = yield vantikDatabase.agentSessions.toArray();
      self.agentSessions = AgentSessionArray.create(sessions ?? []);
    });

    return { update, deleteById, load };
  })
  .views((self) => ({
    /** Every session on one issue, the most recently active first. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getSessionsForIssue(issueId: string): any[] {
      return self.agentSessions
        .filter((session) => session.issueId === issueId)
        .slice()
        .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getSessionById(id: string): any {
      return self.agentSessions.find((session) => session.id === id);
    },
  }));

export type AgentSessionsStoreType = Instance<typeof AgentSessionsStore>;
