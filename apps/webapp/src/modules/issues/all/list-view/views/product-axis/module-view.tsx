import type { AxisGrouping } from './utils';

import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { withoutArchived } from 'modules/product-axis/archive';

import type { ModuleType } from 'common/types';

import { ViewEnum } from 'store/application';
import { useContextStore } from 'store/global-context-provider';

import { AxisBoard } from './axis-board';
import { AxisList } from './axis-list';

/** The issues of a workspace, grouped by the module that each one changes. */
export const ModuleGroupView = observer(() => {
  const {
    applicationStore: {
      displaySettings: { view },
    },
    modulesStore,
  } = useContextStore();

  const modules: ModuleType[] = withoutArchived<ModuleType>(
    modulesStore.getModules,
  );

  const grouping: AxisGrouping = {
    kind: 'module',
    property: 'moduleIds',
    isArray: true,
    listId: 'module-list',
    emptyLabel: 'No module',
    groups: modules.map((module) => ({
      id: module.id,
      name: module.name,
      icon: module.icon,
      color: module.color,
    })),
  };

  return view === ViewEnum.list ? (
    <AxisList grouping={grouping} />
  ) : (
    <AxisBoard grouping={grouping} />
  );
});
