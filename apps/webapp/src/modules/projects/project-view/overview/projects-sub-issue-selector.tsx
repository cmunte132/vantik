import { WorkflowCategoryEnum } from '@vantikhq/types';
import { useEditor } from '@vantikhq/ui/components/editor/index';
import { useRouter } from 'next/router';

import { SubIssueSelector, type IssueContent } from 'common/editor';
import { delay } from 'common/lib/common';
import type { WorkflowType } from 'common/types';

import { useProject } from 'hooks/projects';
import { useTeamWithId } from 'hooks/teams';

import { useCreateIssueMutation } from 'services/issues';

import { useContextStore } from 'store/global-context-provider';

export const ProjectSubIssueSelector = () => {
  const project = useProject();
  const { query } = useRouter();
  const { editor } = useEditor();

  // A project need not name a team, and the team it names can be deleted.
  // This selector files a new issue into a team, so with no team there is
  // nothing for it to file into.
  const team = useTeamWithId(project.teams[0]);
  const { workflowsStore } = useContextStore();
  const workflows = team ? workflowsStore.getWorkflowsForTeam(team.id) : [];
  const backlog = workflows.find(
    (workflow: WorkflowType) =>
      workflow.category === WorkflowCategoryEnum.BACKLOG,
  );
  const { mutate: createIssue } = useCreateIssueMutation({
    onSuccess: (data, variables) => {
      const url = `https://app.vantik.dev/${query.workspaceSlug}/issue/${team?.identifier}-${data.number}`;

      editor
        .chain()
        .focus()
        .insertContentAt(
          {
            from: variables.start,
            to: variables.end,
          },
          {
            type: 'vantikIssueExtension',
            attrs: {
              url,
            },
          },
        )
        .exitCode()
        .run();
    },
  });

  const onCreateIssues = async (issueContents: IssueContent[]) => {
    for (const issueContent of issueContents.reverse()) {
      createIssue({
        description: issueContent.text,
        teamId: team.id,
        title: issueContent.text,
        stateId: backlog.id,
        projectId: project?.id,
        start: issueContent.start,
        end: issueContent.end,
      });

      await delay(200);
    }
  };

  // Below every hook, so the count does not change with the project. Hiding
  // the selector takes one action off the editor; letting it render without a
  // team to file into took the whole project page down.
  if (!team || !backlog) {
    return null;
  }

  return <SubIssueSelector onCreate={onCreateIssues} />;
};
