import { runInAction } from 'mobx';

import type { SyncActionRecord } from 'common/types';

import { saveActionData } from 'store/action';
import { saveChecklistItemData } from 'store/checklist-items';
import { saveCommentsData } from 'store/comments';
import { saveCompanyData } from 'store/company';
import { saveConversationHistorytData } from 'store/conversation-history';
import { saveConversationData } from 'store/conversations';
import { saveCyclesData } from 'store/cycle';
import { saveIntegrationAccountData } from 'store/integration-accounts';
import { saveIssueHistoryData } from 'store/issue-history';
import { saveIssueRelationData } from 'store/issue-relation';
import { saveIssueSuggestionData } from 'store/issue-suggestions';
import { saveIssuesData } from 'store/issues';
import { saveLabelData } from 'store/labels';
import { saveLinkedIssueData } from 'store/linked-issues';
import { MODELS } from 'store/models';
import { saveNotificationData } from 'store/notifications';
import { savePageEntryData } from 'store/page-entries';
import { savePageData } from 'store/pages';
import { savePeopleData } from 'store/people';
import {
  saveProjectData,
  saveProjectMilestoneData,
} from 'store/projects/save-data';
import { saveSupportData } from 'store/support';
import { saveTeamData } from 'store/teams';
import { saveTemplateData } from 'store/templates';
import { saveViewData } from 'store/views';
import { saveWorkflowData } from 'store/workflows';
import { saveWorkspaceData } from 'store/workspace';

// A map of model names to their save functions, to avoid a switch statement.
// It is built once here rather than per call: nothing in it depends on the
// payload, and a test reads it to check every synced model has a handler.
// eslint-disable-next-line @typescript-eslint/ban-types
export const SAVE_HANDLERS: Record<string, Function> = {
  [MODELS.Label]: saveLabelData,
  [MODELS.Team]: saveTeamData,
  [MODELS.Workflow]: saveWorkflowData,
  [MODELS.Workspace]: saveWorkspaceData,
  [MODELS.UsersOnWorkspaces]: saveWorkspaceData,
  [MODELS.Issue]: saveIssuesData,
  [MODELS.IssueHistory]: saveIssueHistoryData,
  [MODELS.IssueComment]: saveCommentsData,
  [MODELS.ChecklistItem]: saveChecklistItemData,
  [MODELS.Page]: savePageData,
  [MODELS.PageEntry]: savePageEntryData,
  [MODELS.IntegrationAccount]: saveIntegrationAccountData,
  [MODELS.LinkedIssue]: saveLinkedIssueData,
  [MODELS.IssueRelation]: saveIssueRelationData,
  [MODELS.Notification]: saveNotificationData,
  [MODELS.View]: saveViewData,
  [MODELS.IssueSuggestion]: saveIssueSuggestionData,
  [MODELS.Action]: saveActionData,
  [MODELS.Project]: saveProjectData,
  [MODELS.ProjectMilestone]: saveProjectMilestoneData,
  [MODELS.Cycle]: saveCyclesData,
  [MODELS.Conversation]: saveConversationData,
  [MODELS.ConversationHistory]: saveConversationHistorytData,
  [MODELS.Template]: saveTemplateData,
  [MODELS.People]: savePeopleData,
  [MODELS.Company]: saveCompanyData,
  [MODELS.Support]: saveSupportData,
};

// Saves the data from the socket and call explicitly functions from individual models
export async function saveSocketData(
  data: SyncActionRecord[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  MODEL_STORE_MAP: Record<string, any>,
) {
  return runInAction(async () => {
    // Pre-initialize the accumulator object with known model names
    const groupedRecords: Record<string, SyncActionRecord[]> = Object.values(
      MODELS,
    ).reduce(
      (acc, model) => {
        acc[model] = [];
        return acc;
      },
      {} as Record<string, SyncActionRecord[]>,
    );

    // Use for...of instead of reduce for better performance with large arrays
    for (const record of data) {
      if (groupedRecords[record.modelName]) {
        groupedRecords[record.modelName].push(record);
      }
    }

    // Process records using the handler map
    return Promise.all(
      Object.entries(groupedRecords)
        .map(([modelName, records]) => {
          if (records.length === 0) {
            return null;
          }
          const handler = SAVE_HANDLERS[modelName];
          return handler ? handler(records, MODEL_STORE_MAP[modelName]) : null;
        })
        .filter(Boolean),
    );
  });
}
