import {
  type IAnyStateTreeNode,
  type Instance,
  types,
  flow,
} from 'mobx-state-tree';

import { vantikDatabase } from 'store/database';

import { AgentRunArray, AgentRunEventArray } from './models';

/**
 * Agent runs and their event streams.
 *
 * Runs are workspace-scoped and loaded up front, because the workspace-level
 * runs view has to answer "what is happening right now" without knowing which
 * issue to ask about. Events are keyed by run and loaded on demand — a chatty
 * harness produces thousands of lines per run, and holding every run's log in
 * memory to render one panel would be paying for all of them to read one.
 */
export const AgentRunsStore: IAnyStateTreeNode = types
  .model({
    agentRuns: AgentRunArray,
    events: types.map(AgentRunEventArray),
  })
  .actions((self) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const update = (agentRun: any, id: string) => {
      const index = self.agentRuns.findIndex((run) => run.id === id);

      if (index !== -1) {
        self.agentRuns[index] = { ...self.agentRuns[index], ...agentRun };
      } else {
        self.agentRuns.push(agentRun);
      }
    };

    const deleteById = (id: string) => {
      const index = self.agentRuns.findIndex((run) => run.id === id);
      if (index !== -1) {
        self.agentRuns.splice(index, 1);
      }
      self.events.delete(id);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateEvent = (event: any, id: string) => {
      const runId = event.runId;

      if (!self.events.has(runId)) {
        self.events.set(runId, AgentRunEventArray.create([]));
      }

      const list = self.events.get(runId);
      const index = list.findIndex((entry) => entry.id === id);

      if (index !== -1) {
        list[index] = { ...list[index], ...event };
      } else {
        list.push(event);
      }
    };

    const deleteEventById = (id: string) => {
      for (const [runId, list] of self.events.entries()) {
        const index = list.findIndex((entry) => entry.id === id);
        if (index !== -1) {
          list.splice(index, 1);
          if (list.length === 0) {
            self.events.delete(runId);
          }
          break;
        }
      }
    };

    const load = flow(function* () {
      const runs = yield vantikDatabase.agentRuns.toArray();
      self.agentRuns = AgentRunArray.create(runs ?? []);
    });

    const loadEvents = flow(function* (runId: string) {
      const events = runId
        ? yield vantikDatabase.agentRunEvents.where({ runId }).toArray()
        : [];

      if (events.length > 0) {
        self.events.set(runId, AgentRunEventArray.create(events));
      }
    });

    return { update, deleteById, updateEvent, deleteEventById, load, loadEvents };
  })
  .views((self) => ({
    /** Every attempt at one issue, newest first. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getRunsForIssue(issueId: string): any[] {
      return self.agentRuns
        .filter((run) => run.issueId === issueId)
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    /**
     * The run to show on an issue: the live one if there is one, otherwise the
     * most recent. A finished run still matters — it is where the pull request
     * link lives.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getCurrentRunForIssue(issueId: string): any {
      const runs = self.agentRuns
        .filter((run) => run.issueId === issueId)
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      return runs.find((run) => LIVE.includes(run.status)) ?? runs[0];
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getEvents(runId: string): any[] {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list: any[] = self.events.has(runId)
        ? [...self.events.get(runId)]
        : [];
      return list.sort((a, b) => a.at.localeCompare(b.at));
    },

    /** Every run, newest first. The session list reads this. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get byRecency(): any[] {
      return self.agentRuns
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getRunById(id: string): any {
      return self.agentRuns.find((run) => run.id === id);
    },

    /** The workspace view: in flight, needs review, failed. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get grouped(): { live: any[]; needsReview: any[]; failed: any[] } {
      const sorted = self.agentRuns
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      return {
        live: sorted.filter((run) => LIVE.includes(run.status)),
        needsReview: sorted.filter((run) =>
          ['SUCCEEDED', 'NEEDS_REVIEW'].includes(run.status),
        ),
        failed: sorted.filter((run) =>
          ['FAILED', 'EXPIRED'].includes(run.status),
        ),
      };
    },
  }));

const LIVE = ['QUEUED', 'CLAIMED', 'RUNNING'];

export type AgentRunsStoreType = Instance<typeof AgentRunsStore>;
