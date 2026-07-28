import {
  Draggable,
  Droppable,
  type DraggableProvided,
  type DraggableStateSnapshot,
  type DroppableProvided,
  type DroppableStateSnapshot,
} from '@hello-pangea/dnd';
import { observer } from 'mobx-react-lite';
import React from 'react';
import {
  AutoSizer,
  CellMeasurer,
  CellMeasurerCache,
  List,
  type ListRowProps,
} from 'react-virtualized';

import { AxisIcon } from 'modules/product-axis/axis-icon';

import type { IssueType } from 'common/types';

import { useCycle } from 'hooks/cycles';
import { useProject } from 'hooks/projects';
import { useCurrentTeam } from 'hooks/teams';
import { useComputedWorkflows } from 'hooks/workflows';

import { useContextStore } from 'store/global-context-provider';

import {
  issueInGroup,
  issueInNoGroup,
  NO_GROUP,
  type AxisGroup,
  type AxisGrouping,
} from './utils';
import { BoardIssueItem } from '../../../../components/issue-board-item/issue-board-item';
import { useFilterIssues } from '../../../../issues-utils';

interface AxisBoardListProps {
  grouping: AxisGrouping;
  /** The group of this column, or undefined for the column of no group. */
  group?: AxisGroup;
}

/**
 * One column of the board.
 *
 * The column reads the issues that the store already scoped to the team, the
 * project and the cycle, and it keeps the ones that name its group. A module
 * column therefore shows an issue that names two modules, and so does the other
 * column.
 */
export const AxisBoardList = observer(
  ({ grouping, group }: AxisBoardListProps) => {
    const { issuesStore, applicationStore } = useContextStore();
    const project = useProject();
    const { workflows } = useComputedWorkflows();
    const team = useCurrentTeam();
    const cycle = useCycle();

    const scoped = issuesStore.getIssues({
      teamId: team?.id,
      projectId: project?.id,
      cycleId: cycle?.id,
    }) as IssueType[];

    const issues = scoped.filter((issue) =>
      group
        ? issueInGroup(issue, grouping, group.id)
        : issueInNoGroup(issue, grouping),
    );

    const computedIssues = useFilterIssues(issues, workflows);

    const cache = new CellMeasurerCache({
      defaultHeight: 100,
      fixedWidth: true,
    });

    if (
      computedIssues.length === 0 &&
      !applicationStore.displaySettings.showEmptyGroups
    ) {
      return null;
    }

    const droppableId = group ? group.id : NO_GROUP;

    const rowRender = ({ index, style, key, parent }: ListRowProps) => {
      const issue = computedIssues[index];

      if (!issue) {
        return null;
      }

      // An issue can sit in two columns at once, so the draggable id carries
      // the column it was dragged from. Without it the two copies share one id
      // and the board refuses to render.
      const id = `${droppableId}__${issue.id}`;

      return (
        <Draggable key={id} draggableId={id} index={index}>
          {(
            dragProvided: DraggableProvided,
            dragSnapshot: DraggableStateSnapshot,
          ) => (
            <CellMeasurer
              key={key}
              cache={cache}
              columnIndex={0}
              parent={parent}
              rowIndex={index}
            >
              {({ registerChild }) => (
                <div style={style} key={key} ref={registerChild}>
                  <BoardIssueItem
                    issueId={issue.id}
                    isDragging={dragSnapshot.isDragging}
                    provided={dragProvided}
                    key={key}
                  />
                </div>
              )}
            </CellMeasurer>
          )}
        </Draggable>
      );
    };

    return (
      <Droppable
        droppableId={droppableId}
        type="BoardColumn"
        mode="virtual"
        ignoreContainerClipping
        renderClone={(provided, snapshot) => {
          const draggableId = provided.draggableProps['data-rfd-draggable-id'];

          const issueId = draggableId.includes('__')
            ? draggableId.split('__')[1]
            : draggableId;

          return (
            <BoardIssueItem
              issueId={issueId}
              isDragging={snapshot.isDragging}
              provided={provided}
            />
          );
        }}
      >
        {(
          droppableProvided: DroppableProvided,
          snapshot: DroppableStateSnapshot,
        ) => {
          const itemCount: number = snapshot.isUsingPlaceholder
            ? computedIssues.length + 1
            : computedIssues.length;

          return (
            <div className="flex flex-col max-h-[100%] w-[350px]">
              <div className="flex gap-1 items-center mb-2 w-[310px]">
                <div className="flex items-center w-fit h-8 rounded-2xl px-4 py-2 bg-grayAlpha-100">
                  <AxisIcon
                    kind={grouping.kind}
                    name={group ? group.name : grouping.emptyLabel}
                    icon={group?.icon}
                    color={group ? group.color : 'var(--grayAlpha-200)'}
                    size="md"
                  />
                  <h3 className="pl-2">
                    {group ? group.name : grouping.emptyLabel}
                  </h3>
                </div>

                <div className="rounded-2xl bg-grayAlpha-100 p-1.5 px-2 font-mono">
                  {computedIssues.length}
                </div>
              </div>

              <div className="flex flex-col grow mr-3">
                <AutoSizer className="pb-10 h-full">
                  {({ width, height }) => (
                    <List
                      ref={(ref) => {
                        // react-virtualized has no public handle to its scroll
                        // container and findDOMNode is gone in React 19, so
                        // reach into the Grid.
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const container = (ref as any)?.Grid
                          ?._scrollingContainer;
                        if (container instanceof HTMLElement) {
                          droppableProvided.innerRef(container);
                        }
                      }}
                      height={height}
                      overscanRowCount={10}
                      noRowsRenderer={() => <></>}
                      width={width}
                      rowCount={itemCount}
                      outerRef={droppableProvided.innerRef}
                      rowHeight={cache.rowHeight}
                      deferredMeasurementCache={cache}
                      rowRenderer={rowRender}
                      shallowCompare
                    />
                  )}
                </AutoSizer>
              </div>
            </div>
          );
        }}
      </Droppable>
    );
  },
);
