import type { Grouping } from './grouping';

import { observer } from 'mobx-react-lite';

import { useFilterIssues } from 'modules/issues/issues-utils';

import { useCycle } from 'hooks/cycles';
import { useProject } from 'hooks/projects';
import { useCurrentTeam } from 'hooks/teams';
import { useComputedWorkflows } from 'hooks/workflows';

import { ViewEnum } from 'store/application';
import { useContextStore } from 'store/global-context-provider';

import { GroupedBoard } from './grouped-board';
import { GroupedList } from './grouped-list';

interface GroupedIssuesProps {
  /** Undefined while what the groups are made of is still loading. */
  grouping: Grouping | undefined;
}

/**
 * The issues of the page, as a list or a board of one grouping.
 *
 * The issues are scoped to the team, the project and the cycle of the page and
 * filtered once, here. Each column of the board used to do both for itself,
 * and two of them left out the cycle: an unassigned issue of another cycle
 * turned up on a cycle's board.
 */
export const GroupedIssues = observer(({ grouping }: GroupedIssuesProps) => {
  const {
    applicationStore: {
      displaySettings: { view },
    },
    issuesStore,
  } = useContextStore();
  const team = useCurrentTeam();
  const project = useProject();
  const cycle = useCycle();
  const { workflows } = useComputedWorkflows();

  const scoped = issuesStore.getIssues({
    teamId: team?.id,
    projectId: project?.id,
    cycleId: cycle?.id,
  });
  const issues = useFilterIssues(scoped, workflows);

  if (!grouping) {
    return null;
  }

  return view === ViewEnum.list ? (
    <GroupedList grouping={grouping} issues={issues} />
  ) : (
    <GroupedBoard grouping={grouping} issues={issues} />
  );
});
