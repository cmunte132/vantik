import type { Grouping } from './grouping';

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

import { IssueRelationEnum, type IssueType } from 'common/types';

import { ScrollManagedList } from 'components/scroll-managed-list';

import { useContextStore } from 'store/global-context-provider';

import { GroupLabel, groupChipStyle } from './group-header';
import { getIssueRows, headerOf } from './grouping';

interface GroupedListProps {
  grouping: Grouping;
  issues: IssueType[];
}

/** The issues of the page, under a header for each group. */
export const GroupedList = observer(
  ({ grouping, issues }: GroupedListProps) => {
    const {
      applicationStore: {
        displaySettings: { showEmptyGroups },
      },
      issuesStore,
      issueRelationsStore,
    } = useContextStore();

    const [_heightChange, setHeightChange] = React.useState(false);

    // A row with a relation shows it under the title, so it starts taller.
    const hasRelations = (issue: IssueType) =>
      issueRelationsStore.getIssueRelationForType(
        issue.id,
        IssueRelationEnum.BLOCKED,
      ).length > 0 ||
      issueRelationsStore.getIssueRelationForType(
        issue.id,
        IssueRelationEnum.BLOCKS,
      ).length > 0 ||
      issuesStore.getIssueById(issue.parentId) !== undefined ||
      issuesStore.getSubIssues(issue.id).length > 0;

    const rows = getIssueRows(issues, grouping, showEmptyGroups, hasRelations);

    const cache = new CellMeasurerCache({
      defaultHeight: 45,
      fixedWidth: true,
    });

    React.useEffect(() => {
      cache.clearAll();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows]);

    const headerRow = (key: string, index: number) => {
      const header = headerOf(grouping, key);

      if (!header) {
        return null;
      }

      const chip = groupChipStyle(header);

      return (
        <Button
          className={cn(
            'flex items-center ml-4 mb-2 w-fit cursor-default',
            chip.className,
            index !== 0 && 'mt-4',
          )}
          style={chip.style}
          size="lg"
          variant="ghost"
        >
          <GroupLabel header={header} />
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
                headerRow(row.key, index)
              ) : (
                <IssueListItem
                  issueId={row.issueId}
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
  },
);
