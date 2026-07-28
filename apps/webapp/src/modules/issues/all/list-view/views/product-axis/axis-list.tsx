import { Button } from '@vantikhq/ui/components/button';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import React from 'react';
import {
  AutoSizer,
  CellMeasurer,
  CellMeasurerCache,
  type Index,
  type ListRowProps,
} from 'react-virtualized';

import { IssueListItem } from 'modules/issues/components';
import { useFilterIssues } from 'modules/issues/issues-utils';
import { AxisIcon } from 'modules/product-axis/axis-icon';

import { ScrollManagedList } from 'components/scroll-managed-list';
import { useCycle } from 'hooks/cycles';
import { useProject } from 'hooks/projects';
import { useCurrentTeam } from 'hooks/teams';
import { useComputedWorkflows } from 'hooks/workflows';

import { useContextStore } from 'store/global-context-provider';

import { useAxisIssueRows, type AxisGrouping } from './utils';

interface AxisListProps {
  grouping: AxisGrouping;
}

/**
 * The issues of a workspace, under a header for each module or capability.
 *
 * An issue can name more than one module, so an issue appears under each module
 * it names. That is what a label already does, and it is the honest shape: the
 * work is in two places.
 */
export const AxisList = observer(({ grouping }: AxisListProps) => {
  const project = useProject();
  const cycle = useCycle();
  const team = useCurrentTeam();

  const [_heightChange, setHeightChange] = React.useState(false);

  const { issuesStore } = useContextStore();
  const issues = issuesStore.getIssues({
    teamId: team?.id,
    projectId: project?.id,
    cycleId: cycle?.id,
  });
  const { workflows } = useComputedWorkflows();
  const filteredIssues = useFilterIssues(issues, workflows);

  const rows = useAxisIssueRows(filteredIssues, grouping);

  const cache = new CellMeasurerCache({
    defaultHeight: 45,
    fixedWidth: true,
  });

  React.useEffect(() => {
    cache.clearAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const getHeaderRow = (row: { type: string; key: string }, index: number) => {
    if (!row) {
      return null;
    }

    const group = grouping.groups.find((group) => group.id === row.key);
    const childContent =
      row.key === 'no-value' || !group ? (
        <>
          <AxisIcon
            kind={grouping.kind}
            name={grouping.emptyLabel}
            color="var(--grayAlpha-200)"
          />
          <h3 className="pl-2">{grouping.emptyLabel}</h3>
        </>
      ) : (
        <>
          <AxisIcon
            kind={grouping.kind}
            name={group.name}
            icon={group.icon}
            color={group.color}
          />
          <h3 className="pl-2">{group.name}</h3>
        </>
      );

    return (
      <Button
        className={cn(
          'flex group items-center ml-4 w-fit rounded-2xl bg-grayAlpha-100 mb-2 cursor-default',
          index !== 0 && 'mt-4',
        )}
        size="lg"
        variant="ghost"
      >
        {childContent}
      </Button>
    );
  };

  const changeHeight = (_issueCount: number, index: number) => {
    cache.clear(index, 0);
    setHeightChange(!_heightChange);
  };

  const rowRender = ({ index, style, key, parent }: ListRowProps) => {
    const row = rows[index];

    if (!row) {
      return null;
    }

    return (
      <CellMeasurer
        key={key}
        cache={cache}
        columnIndex={0}
        parent={parent}
        rowIndex={index}
      >
        {({ registerChild }) => (
          <div style={style} key={key} ref={registerChild}>
            {row.type === 'header' ? (
              getHeaderRow(row, index)
            ) : (
              <IssueListItem
                issueId={row.issueId}
                key={index}
                changeHeight={(issueCount) => changeHeight(issueCount, index)}
              />
            )}
          </div>
        )}
      </CellMeasurer>
    );
  };

  const rowHeight = ({ index }: Index) => {
    const row = rows[index];

    if (row && row.type === 'issue') {
      const defaultHeight = row.hasRelations ? 73 : 45;

      return Math.max(cache.getHeight(index, 0), defaultHeight);
    }

    return cache.getHeight(index, 0);
  };

  return (
    <AutoSizer className="h-full">
      {({ width, height }) => (
        <ScrollManagedList
          className=""
          listId={grouping.listId}
          height={height}
          overscanRowCount={10}
          noRowsRenderer={() => <></>}
          rowCount={rows.length + 2}
          rowHeight={rowHeight}
          deferredMeasurementCache={cache}
          rowRenderer={rowRender}
          width={width}
          shallowCompare
        />
      )}
    </AutoSizer>
  );
});
