import type { AxisGrouping } from './utils';

import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { withoutArchived } from 'modules/product-axis/archive';

import type { CapabilityType } from 'common/types';

import { ViewEnum } from 'store/application';
import { useContextStore } from 'store/global-context-provider';

import { AxisBoard } from './axis-board';
import { AxisList } from './axis-list';

/**
 * The issues of a workspace, grouped by the capability that each one builds.
 *
 * A capability holds no icon and no colour of its own, so `AxisIcon` gives it
 * one from its name.
 */
export const CapabilityGroupView = observer(() => {
  const {
    applicationStore: {
      displaySettings: { view },
    },
    capabilitiesStore,
  } = useContextStore();

  const capabilities: CapabilityType[] = withoutArchived<CapabilityType>(
    capabilitiesStore.getCapabilities,
  );

  const grouping: AxisGrouping = {
    kind: 'capability',
    property: 'capabilityId',
    isArray: false,
    listId: 'capability-list',
    emptyLabel: 'No capability',
    groups: capabilities.map((capability) => ({
      id: capability.id,
      name: capability.name,
    })),
  };

  return view === ViewEnum.list ? (
    <AxisList grouping={grouping} />
  ) : (
    <AxisBoard grouping={grouping} />
  );
});
