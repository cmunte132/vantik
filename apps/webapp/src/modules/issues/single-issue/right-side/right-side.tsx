import { WorkflowCategoryEnum } from '@vantikhq/types';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@vantikhq/ui/components/alert-dialog';
import { ScrollArea } from '@vantikhq/ui/components/scroll-area';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import React from 'react';

import {
  IssueAssigneeDropdown,
  IssueAssigneeDropdownVariant,
  IssueLabelDropdown,
  IssueLabelDropdownVariant,
  IssuePriorityDropdown,
  IssuePriorityDropdownVariant,
  IssueStatusDropdown,
  IssueStatusDropdownVariant,
} from 'modules/issues/components';
import {
  ProjectDropdown,
  ProjectDropdownVariant,
  ProjectMilestoneDropdown,
  ProjectMilestoneDropdownVariant,
} from 'modules/issues/components/issue-metadata/project';

import type { ChecklistItemType } from 'common/types';

import { useIssueData } from 'hooks/issues';
import { useTeamWithId } from 'hooks/teams';
import { useTeamWorkflows } from 'hooks/workflows';

import { useUpdateIssueMutation } from 'services/issues';

import { useContextStore } from 'store/global-context-provider';

import { EngineeringProperties } from './engineering-properties';
import { IssueRelatedProperties } from './issue-related-properties';
import { SupportProperties } from './support-properties';

export const RightSide = observer(() => {
  const issue = useIssueData();
  const { mutate: updateIssue } = useUpdateIssueMutation({});
  const { projectsStore, checklistItemsStore } = useContextStore();
  const team = useTeamWithId(issue?.teamId);
  const hasProjectsForTeam = projectsStore.hasProjects(team.id);

  const workflows = useTeamWorkflows(team.identifier);
  // A state the caller picked that would complete the issue while criteria are
  // still open. Held until they confirm, so the move is warned about, not
  // blocked.
  const [pendingStateId, setPendingStateId] = React.useState<
    string | undefined
  >();

  const criteria = checklistItemsStore.getChecklistItems(
    issue.id,
  ) as ChecklistItemType[];
  const openCriteria = criteria.filter(
    (item: ChecklistItemType) => !item.completed,
  );

  const applyStatus = (stateId: string) => {
    updateIssue({ id: issue.id, stateId, teamId: issue.teamId });
  };

  const statusChange = (stateId: string) => {
    const nextWorkflow = workflows.find(
      (workflow: { id: string }) => workflow.id === stateId,
    );
    const completesIssue =
      nextWorkflow?.category === WorkflowCategoryEnum.COMPLETED;

    if (completesIssue && openCriteria.length > 0) {
      setPendingStateId(stateId);
      return;
    }

    applyStatus(stateId);
  };

  const assigneeChange = (assigneeId: string) => {
    updateIssue({ id: issue.id, assigneeId, teamId: issue.teamId });
  };

  const labelsChange = (labelIds: string[]) => {
    updateIssue({ id: issue.id, labelIds, teamId: issue.teamId });
  };

  const projectChange = (projectId: string) => {
    updateIssue({
      id: issue.id,
      projectId,
      projectMilestoneId: null,
      teamId: issue.teamId,
    });
  };

  const projectMilestoneChange = (projectMilestoneId: string) => {
    updateIssue({ id: issue.id, projectMilestoneId, teamId: issue.teamId });
  };

  const priorityChange = (priority: number) => {
    updateIssue({
      id: issue.id,
      priority,
      teamId: issue.teamId,
    });
  };

  return (
    <>
      <ScrollArea className="h-full">
        <div className="grow p-6 flex flex-col gap-4 pb-10">
          <div className="flex flex-col items-start">
            <label className="text-xs">Status</label>
            <IssueStatusDropdown
              value={issue.stateId}
              onChange={statusChange}
              variant={IssueStatusDropdownVariant.LINK}
              teamIdentifier={team.identifier}
            />
          </div>

          <div className="flex flex-col items-start">
            <label className="text-xs">Priority</label>

            <IssuePriorityDropdown
              value={issue.priority ?? 0}
              onChange={priorityChange}
              variant={IssuePriorityDropdownVariant.LINK}
            />
          </div>

          <div className="flex flex-col items-start">
            <label className="text-xs">Assignee</label>

            <IssueAssigneeDropdown
              value={issue.assigneeId}
              teamId={team.id}
              onChange={assigneeChange}
              variant={IssueAssigneeDropdownVariant.LINK}
            />
          </div>

          <IssueRelatedProperties />

          <div className={cn('flex flex-col items-start')}>
            <div className="text-xs text-left">Labels</div>

            <IssueLabelDropdown
              value={issue.labelIds}
              onChange={labelsChange}
              variant={IssueLabelDropdownVariant.LINK}
              teamIdentifier={team.identifier}
            />
          </div>

          {hasProjectsForTeam && (
            <div className={cn('flex flex-col items-start')}>
              <div className="text-xs text-left">Project</div>

              <ProjectDropdown
                value={issue.projectId}
                onChange={projectChange}
                variant={ProjectDropdownVariant.LINK}
                teamIdentifier={team.identifier}
              />
            </div>
          )}

          {issue.projectId && (
            <div className={cn('flex flex-col items-start')}>
              <div className="text-xs text-left">Project Milestone</div>

              <ProjectMilestoneDropdown
                value={issue.projectMilestoneId}
                onChange={projectMilestoneChange}
                variant={ProjectMilestoneDropdownVariant.LINK}
                teamIdentifier={team.identifier}
                projectId={issue.projectId}
              />
            </div>
          )}

          {team.preferences?.teamType === 'support' ? (
            <SupportProperties />
          ) : (
            <EngineeringProperties />
          )}
        </div>
      </ScrollArea>

      <AlertDialog
        open={!!pendingStateId}
        onOpenChange={(open) => !open && setPendingStateId(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Definition of Done not met</AlertDialogTitle>
            <AlertDialogDescription>
              {openCriteria.length} of {criteria.length} criteria are still
              unchecked. You can still complete this issue.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                applyStatus(pendingStateId);
                setPendingStateId(undefined);
              }}
            >
              Complete anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
});
