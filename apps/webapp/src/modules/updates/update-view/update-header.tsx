import { Button } from '@vantikhq/ui/components/button';
import { observer } from 'mobx-react-lite';
import Link from 'next/link';
import { useRouter } from 'next/router';

import { type IssueType, type WorkflowType } from 'common/types';
import { getWorkflowIcon } from 'common/workflow-icons';
import { workspaceHref } from 'common/workspace-href';

import { useTeamWithId } from 'hooks/teams';
import { useTeamWorkflows } from 'hooks/workflows';

interface UpdateHeaderProps {
  issue: IssueType;
}

/**
 * Which issue the updates below belong to, and the way out to it.
 *
 * This is the whole of the issue that the inbox shows. Status, priority,
 * labels and modules are the issue's, not the update's, so they live on the
 * issue page and this header links there instead of copying them.
 */
export const UpdateHeader = observer(({ issue }: UpdateHeaderProps) => {
  const {
    query: { workspaceSlug },
  } = useRouter();

  const team = useTeamWithId(issue.teamId);
  const workflows = useTeamWorkflows(team?.identifier);
  const workflow = workflows.find(
    (item: WorkflowType) => item.id === issue.stateId,
  );
  const Icon = workflow ? getWorkflowIcon(workflow) : undefined;

  return (
    <div className="flex items-center gap-3 px-6 py-3 border-b border-border">
      <div className="grow min-w-0 flex items-center gap-2">
        {team && (
          <span className="shrink-0 text-muted-foreground text-sm">
            {`${team.identifier}-${issue.number}`}
          </span>
        )}

        <h2 className="truncate font-medium">{issue.title}</h2>

        {workflow && Icon && (
          <span className="shrink-0 inline-flex items-center gap-1 text-sm text-muted-foreground">
            <Icon size={16} />
            {workflow.name}
          </span>
        )}
      </div>

      {team && (
        <Button variant="secondary" className="shrink-0" asChild>
          <Link
            href={workspaceHref(
              workspaceSlug,
              'issue',
              `${team.identifier}-${issue.number}`,
            )}
          >
            Open issue
          </Link>
        </Button>
      )}
    </div>
  );
});
