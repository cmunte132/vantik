import type { Grouping } from './grouping';

import {
  RiAccountCircleLine,
  RiBox3Line,
  RiPriceTag3Line,
} from '@remixicon/react';
import { WorkflowCategoryEnum } from '@vantikhq/types';
import { AvatarText } from '@vantikhq/ui/components/avatar';
import { BadgeColor } from '@vantikhq/ui/components/badge';
import { TeamIcon } from '@vantikhq/ui/components/team-icon';
import { sort } from 'fast-sort';
import { observer } from 'mobx-react-lite';

import { PriorityIcons } from 'modules/issues/components';
import { withoutArchived } from 'modules/product-axis/archive';
import { AxisIcon } from 'modules/product-axis/axis-icon';

import { workflowSort } from 'common/sorting';
import { getWorkflowColor } from 'common/status-color';
import type {
  CapabilityType,
  LabelType,
  ModuleType,
  ProjectType,
  TeamType,
  User,
  WorkflowType,
} from 'common/types';
import { getWorkflowIcon } from 'common/workflow-icons';

import { useComputedLabels } from 'hooks/labels';
import { usePriorities } from 'hooks/priorities';
import { useProjects } from 'hooks/projects';
import { useTeams } from 'hooks/teams';
import { useUsersData } from 'hooks/users';
import { useComputedWorkflows } from 'hooks/workflows';

import { TimeBasedFilterEnum, ViewEnum } from 'store/application';
import { useContextStore } from 'store/global-context-provider';

import { GroupedIssues } from './grouped-issues';

/**
 * Each grouping, built out of the stores. `grouping.ts` says what a grouping
 * is; this says what each one holds and how its headers look.
 */

// A list reads top to bottom, so the work under way comes first. A board reads
// left to right, as work moves.
const LIST_STATUS_ORDER = [
  WorkflowCategoryEnum.UNSTARTED,
  WorkflowCategoryEnum.STARTED,
  WorkflowCategoryEnum.COMPLETED,
  WorkflowCategoryEnum.BACKLOG,
  WorkflowCategoryEnum.TRIAGE,
  WorkflowCategoryEnum.CANCELED,
];

const BOARD_STATUS_ORDER = [
  WorkflowCategoryEnum.TRIAGE,
  WorkflowCategoryEnum.BACKLOG,
  WorkflowCategoryEnum.UNSTARTED,
  WorkflowCategoryEnum.STARTED,
  WorkflowCategoryEnum.COMPLETED,
  WorkflowCategoryEnum.CANCELED,
];

function useStatusGrouping(): Grouping {
  const {
    applicationStore: {
      displaySettings: { completedFilter, view },
    },
  } = useContextStore();
  const { workflows, workflowMap } = useComputedWorkflows();

  const order = view === ViewEnum.list ? LIST_STATUS_ORDER : BOARD_STATUS_ORDER;

  // With completed issues hidden, their statuses are too.
  const shown = workflows
    .filter(
      (workflow: WorkflowType) =>
        completedFilter !== TimeBasedFilterEnum.None ||
        (workflow.category !== WorkflowCategoryEnum.COMPLETED &&
          workflow.category !== WorkflowCategoryEnum.CANCELED),
    )
    .sort((a, b) => workflowSort(a, b, order));

  return {
    field: 'stateId',
    isArray: false,
    listId: 'status-list',
    groups: shown.map((workflow) => {
      const StatusIcon = getWorkflowIcon(workflow);

      return {
        id: workflow.id,
        name: workflow.name,
        icon: <StatusIcon size={20} />,
        color: getWorkflowColor(workflow).background,
        values: workflow.ids.map((id) => ({
          value: id,
          teamId: workflowMap[id]?.teamId,
        })),
      };
    }),
  };
}

function useAssigneeGrouping(): Grouping | undefined {
  const { users, isLoading } = useUsersData(false);

  // Until the members arrive every issue would sit under "No assignee".
  if (isLoading) {
    return undefined;
  }

  return {
    field: 'assigneeId',
    isArray: false,
    listId: 'assignee-list',
    groups: sort(users as User[])
      .asc((user) => user.fullname)
      .map((user) => ({
        id: user.id,
        name: user.fullname,
        icon: (
          <AvatarText text={user.fullname} className="h-5 w-5 text-[9px]" />
        ),
        values: [{ value: user.id }],
      })),
    empty: {
      name: 'No assignee',
      icon: <RiAccountCircleLine size={20} />,
      value: null,
    },
  };
}

function useLabelGrouping(): Grouping {
  const { labels, labelMap } = useComputedLabels();

  return {
    field: 'labelIds',
    isArray: true,
    listId: 'label-list',
    groups: sort(labels as LabelType[])
      .asc((label) => label.name)
      .map((label) => ({
        id: label.id,
        name: label.name,
        icon: (
          <div className="h-5 w-5 flex items-center justify-center">
            <BadgeColor
              style={{ backgroundColor: label.color }}
              className="w-2 h-2"
            />
          </div>
        ),
        // A workspace label has no team, and any team's issue can hold it.
        values: label.ids.map((id) => ({
          value: id,
          teamId: labelMap[id]?.teamId ?? null,
        })),
      })),
    empty: {
      name: 'No label',
      icon: <RiPriceTag3Line size={20} />,
      value: null,
    },
  };
}

function usePriorityGrouping(): Grouping {
  const priorities = usePriorities();

  const icon = (priority: number) => {
    const PriorityIcon = PriorityIcons[priority].icon;

    return <PriorityIcon size={20} />;
  };

  // Zero is no priority, so it is the group of nothing and comes last.
  return {
    field: 'priority',
    isArray: false,
    listId: 'priority-list',
    groups: [1, 2, 3, 4].map((priority) => ({
      id: String(priority),
      name: priorities[priority],
      icon: icon(priority),
      values: [{ value: priority }],
    })),
    empty: { name: 'No priority', icon: icon(0), value: 0 },
  };
}

function useProjectGrouping(): Grouping {
  const projects: ProjectType[] = useProjects();

  return {
    field: 'projectId',
    isArray: false,
    listId: 'project-list',
    groups: projects.map((project) => ({
      id: project.id,
      name: project.name,
      icon: <RiBox3Line size={20} />,
      values: [{ value: project.id }],
    })),
    empty: {
      name: 'No project',
      icon: <RiBox3Line size={20} />,
      value: null,
    },
  };
}

function useTeamGrouping(): Grouping {
  const teams: TeamType[] = useTeams();

  return {
    field: 'teamId',
    isArray: false,
    listId: 'team-list',
    // Moving an issue to another team gives it a new number and a new status,
    // and the move dialog asks before it does. A drag sent it as an update to
    // the new team, which found no such issue there and failed every time.
    readOnly: true,
    groups: sort(teams)
      .asc((team) => team.name)
      .map((team) => ({
        id: team.id,
        name: team.name,
        icon: <TeamIcon preferences={team.preferences} name={team.name} />,
        values: [{ value: team.id }],
      })),
  };
}

/** A module of the workspace. An issue can change more than one. */
function useModuleGrouping(): Grouping {
  const { modulesStore } = useContextStore();
  const modules = withoutArchived<ModuleType>(modulesStore.getModules);

  return {
    field: 'moduleIds',
    isArray: true,
    listId: 'module-list',
    groups: sort(modules)
      .asc((module) => module.name)
      .map((module) => ({
        id: module.id,
        name: module.name,
        icon: (
          <AxisIcon
            kind="module"
            name={module.name}
            icon={module.icon}
            color={module.color}
          />
        ),
        values: [{ value: module.id }],
      })),
    empty: {
      name: 'No module',
      icon: (
        <AxisIcon kind="module" name="No module" color="var(--grayAlpha-200)" />
      ),
      value: null,
    },
  };
}

/**
 * A capability of the workspace. A capability holds no icon and no colour of
 * its own, so `AxisIcon` gives it one from its name.
 */
function useCapabilityGrouping(): Grouping {
  const { capabilitiesStore } = useContextStore();
  const capabilities = withoutArchived<CapabilityType>(
    capabilitiesStore.getCapabilities,
  );

  return {
    field: 'capabilityId',
    isArray: false,
    listId: 'capability-list',
    groups: sort(capabilities)
      .asc((capability) => capability.name)
      .map((capability) => ({
        id: capability.id,
        name: capability.name,
        icon: <AxisIcon kind="capability" name={capability.name} />,
        values: [{ value: capability.id }],
      })),
    empty: {
      name: 'No capability',
      icon: (
        <AxisIcon
          kind="capability"
          name="No capability"
          color="var(--grayAlpha-200)"
        />
      ),
      value: null,
    },
  };
}

export const StatusView = observer(() => (
  <GroupedIssues grouping={useStatusGrouping()} />
));

export const AssigneeView = observer(() => (
  <GroupedIssues grouping={useAssigneeGrouping()} />
));

export const LabelView = observer(() => (
  <GroupedIssues grouping={useLabelGrouping()} />
));

export const PriorityView = observer(() => (
  <GroupedIssues grouping={usePriorityGrouping()} />
));

export const ProjectView = observer(() => (
  <GroupedIssues grouping={useProjectGrouping()} />
));

export const TeamView = observer(() => (
  <GroupedIssues grouping={useTeamGrouping()} />
));

export const ModuleView = observer(() => (
  <GroupedIssues grouping={useModuleGrouping()} />
));

export const CapabilityView = observer(() => (
  <GroupedIssues grouping={useCapabilityGrouping()} />
));
