import { WorkflowCategoryEnum } from '@vantikhq/types';
import { useEditor } from '@vantikhq/ui/components/editor/index';
import { useRouter } from 'next/router';

import { SubIssueSelector, type IssueContent } from 'common/editor';
import type { IssueType, WorkflowType } from 'common/types';

import { useIssueData } from 'hooks/issues';
import { useTeamWithId } from 'hooks/teams';

import { useCreateIssueMutation } from 'services/issues';

import { useContextStore } from 'store/global-context-provider';

export const IssueSubIssueSelector = () => {
  const issue = useIssueData();
  const { query } = useRouter();
  const { editor } = useEditor();

  const team = useTeamWithId(issue.teamId);
  const { workflowsStore } = useContextStore();
  const workflows = workflowsStore.getWorkflowsForTeam(team.id);
  const backlog = workflows.find(
    (workflow: WorkflowType) =>
      workflow.category === WorkflowCategoryEnum.BACKLOG,
  );
  const { mutate: createIssue } = useCreateIssueMutation({});

  const onCreateIssues = (issueContents: IssueContent[]) => {
    issueContents.forEach((issueContent) => {
      createIssue(
        {
          description: issueContent.text,
          teamId: team.id,
          stateId: backlog.id,
          projectId: issue.projectId,
          parentId: issue.id,
        },
        {
          onSuccess: (issue: IssueType) => {
            const url = `https://app.vantik.dev/${query.workspaceSlug}/issue/${team.identifier}-${issue.number}`;

            editor
              .chain()
              .focus()
              .insertContentAt(
                {
                  from: issueContent.start,
                  to: issueContent.end,
                },
                {
                  type: 'vantikIssueExtension',
                  attrs: {
                    url,
                  },
                },
              )
              .run();
          },
        },
      );
    });
  };

  return <SubIssueSelector subIssue onCreate={onCreateIssues} />;
};
