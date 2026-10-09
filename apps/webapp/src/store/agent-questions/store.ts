import {
  type IAnyStateTreeNode,
  type Instance,
  types,
  flow,
} from 'mobx-state-tree';

import { vantikDatabase } from 'store/database';

import { AgentQuestionArray } from './models';

/**
 * Agent questions, from every harness.
 *
 * Loaded workspace-wide: the Needs you view and its indicator read the open
 * ones of the whole workspace, and the run view reads the ones of one issue.
 */
export const AgentQuestionsStore: IAnyStateTreeNode = types
  .model({
    agentQuestions: AgentQuestionArray,
  })
  .actions((self) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const update = (agentQuestion: any, id: string) => {
      const index = self.agentQuestions.findIndex(
        (question) => question.id === id,
      );

      if (index !== -1) {
        self.agentQuestions[index] = {
          ...self.agentQuestions[index],
          ...agentQuestion,
        };
      } else {
        self.agentQuestions.push(agentQuestion);
      }
    };

    const deleteById = (id: string) => {
      const index = self.agentQuestions.findIndex(
        (question) => question.id === id,
      );
      if (index !== -1) {
        self.agentQuestions.splice(index, 1);
      }
    };

    const load = flow(function* () {
      const questions = yield vantikDatabase.agentQuestions.toArray();
      self.agentQuestions = AgentQuestionArray.create(questions ?? []);
    });

    return { update, deleteById, load };
  })
  .views((self) => ({
    /** Every question on one issue, the newest first. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getQuestionsForIssue(issueId: string): any[] {
      return self.agentQuestions
        .filter((question) => question.issueId === issueId)
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getQuestionById(id: string): any {
      return self.agentQuestions.find((question) => question.id === id);
    },

    /** Every question that waits for an answer, the oldest first. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get openQuestions(): any[] {
      return self.agentQuestions
        .filter((question) => question.status === 'OPEN')
        .slice()
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
  }));

export type AgentQuestionsStoreType = Instance<typeof AgentQuestionsStore>;
