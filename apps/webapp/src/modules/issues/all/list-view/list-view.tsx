import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { ViewEnum } from 'store/application';
import { useContextStore } from 'store/global-context-provider';

import { viewNameForGrouping, type GroupingViewName } from './grouping-views';
import { AssigneeView } from './views/assignee';
import { CategoryView } from './views/category';
import { LabelView } from './views/label';
import { PriorityView } from './views/priority';
import { CapabilityGroupView, ModuleGroupView } from './views/product-axis';
import { ProjectView } from './views/projects';
import { TableView } from './views/table-view';
import { TeamView } from './views/team';

/**
 * The component of each view. `grouping-views.ts` says which view a grouping
 * gets, and this record says what that view is made of. The key is closed, so
 * a view named there with no component here fails the build.
 */
const COMPONENT_FOR_VIEW: Record<GroupingViewName, React.ComponentType> = {
  assignee: AssigneeView,
  priority: PriorityView,
  label: LabelView,
  project: ProjectView,
  team: TeamView,
  module: ModuleGroupView,
  capability: CapabilityGroupView,
  status: CategoryView,
};

export const ListView = observer(() => {
  const { applicationStore } = useContextStore();

  const {
    displaySettings: { view, grouping },
  } = applicationStore;

  if (view === ViewEnum.sheet) {
    return <TableView />;
  }

  const Grouped = COMPONENT_FOR_VIEW[viewNameForGrouping(grouping)];

  return <Grouped />;
});
