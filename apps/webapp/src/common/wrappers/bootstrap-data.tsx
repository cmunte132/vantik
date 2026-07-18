'use client';

import { Loader } from '@vantikhq/ui/components/loader';
import * as React from 'react';

import { hash } from 'common/common-utils';
import type { BootstrapResponse } from 'common/types';

import { useCurrentWorkspace } from 'hooks/workspace';

import { getBootstrapRecords, getDeltaRecords } from 'services/sync';

import { vantikDatabase } from 'store/database';
import { useContextStore } from 'store/global-context-provider';
import { MODELS } from 'store/models';
import { UserContext } from 'store/user-context';

import { saveSocketData } from './socket-data-util';

interface Props {
  children: React.ReactElement;
}

export function BootstrapWrapper({ children }: Props) {
  const workspace = useCurrentWorkspace();
  const user = React.useContext(UserContext);
  const [loading, setLoading] = React.useState(true);
  const hashKey = `${workspace.id}__${user.id}`;
  const lastSequenceId =
    localStorage && localStorage.getItem(`lastSequenceId_${hash(hashKey)}`);

  const {
    commentsStore,
    issuesHistoryStore,
    issuesStore,
    workflowsStore,
    workspaceStore,
    teamsStore,
    labelsStore,
    integrationAccountsStore,
    linkedIssuesStore,
    issueRelationsStore,
    notificationsStore,
    viewsStore,
    issueSuggestionsStore,
    actionsStore,
    projectsStore,
    projectMilestonesStore,
    cyclesStore,
    conversationsStore,
    conversationHistoryStore,
    templatesStore,
    supportStore,
    peopleStore,
    companiesStore,
  } = useContextStore();

  const MODEL_STORE_MAP = {
    [MODELS.Label]: labelsStore,
    [MODELS.Workspace]: workspaceStore,
    [MODELS.UsersOnWorkspaces]: workspaceStore,
    [MODELS.Team]: teamsStore,
    [MODELS.Workflow]: workflowsStore,
    [MODELS.Issue]: issuesStore,
    [MODELS.IssueHistory]: issuesHistoryStore,
    [MODELS.IssueComment]: commentsStore,
    [MODELS.IntegrationAccount]: integrationAccountsStore,
    [MODELS.LinkedIssue]: linkedIssuesStore,
    [MODELS.IssueRelation]: issueRelationsStore,
    [MODELS.Notification]: notificationsStore,
    [MODELS.View]: viewsStore,
    [MODELS.IssueSuggestion]: issueSuggestionsStore,
    [MODELS.Action]: actionsStore,
    [MODELS.Project]: projectsStore,
    [MODELS.ProjectMilestone]: projectMilestonesStore,
    [MODELS.Cycle]: cyclesStore,
    [MODELS.Conversation]: conversationsStore,
    [MODELS.ConversationHistory]: conversationHistoryStore,
    [MODELS.Template]: templatesStore,
    [MODELS.People]: peopleStore,
    [MODELS.Company]: companiesStore,
    [MODELS.Support]: supportStore,
  };

  React.useEffect(() => {
    if (workspace) {
      initStore();
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveRecords = async (data: BootstrapResponse) => {
    await saveSocketData(data.syncActions, MODEL_STORE_MAP);
    localStorage.setItem(
      `lastSequenceId_${hash(hashKey)}`,
      `${data.lastSequenceId}`,
    );
  };

  const bootstrapRecords = async () => {
    await saveRecords(
      await getBootstrapRecords(workspace?.id, Object.values(MODELS), user.id),
    );
  };

  const syncRecords = async () => {
    await saveRecords(
      await getDeltaRecords(
        workspace?.id,
        Object.values(MODELS),
        lastSequenceId,
        user.id,
      ),
    );
  };

  const initStore = async () => {
    const storeWorkspace = await vantikDatabase.workspaces.get({
      id: workspace.id,
    });

    // A failed sync must not wedge the loader — the socket connection will
    // catch the store up once the server is reachable again.
    try {
      if (storeWorkspace?.id && lastSequenceId) {
        setLoading(false);
        await syncRecords();
      } else {
        await bootstrapRecords();
      }
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <Loader text="Syncing data..." />;
  }

  return <>{children}</>;
}
