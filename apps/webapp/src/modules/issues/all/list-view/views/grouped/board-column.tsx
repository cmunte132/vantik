import type { GroupHeader } from './grouping';

import {
  Draggable,
  Droppable,
  type DraggableProvided,
  type DraggableStateSnapshot,
  type DroppableProvided,
  type DroppableStateSnapshot,
} from '@hello-pangea/dnd';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import React from 'react';
import {
  AutoSizer,
  CellMeasurer,
  CellMeasurerCache,
  List,
  type ListRowProps,
} from 'react-virtualized';

import { BoardIssueItem } from 'modules/issues/components/issue-board-item';

import type { IssueType } from 'common/types';

import { useContextStore } from 'store/global-context-provider';

import { GroupLabel, groupChipStyle } from './group-header';
import { draggableIdFor, issueIdOfDraggable } from './grouping';

interface BoardColumnProps {
  /** The id of the group, or `NO_GROUP`. */
  id: string;
  header: GroupHeader;
  issues: IssueType[];
  /** Whether the cards stay where they are. */
  readOnly?: boolean;
}

/** One column of the board: its header, its count, and its cards. */
export const BoardColumn = observer(
  ({ id, header, issues, readOnly }: BoardColumnProps) => {
    const { applicationStore } = useContextStore();

    const cache = new CellMeasurerCache({
      defaultHeight: 100,
      fixedWidth: true,
    });

    if (
      issues.length === 0 &&
      !applicationStore.displaySettings.showEmptyGroups
    ) {
      return null;
    }

    const chip = groupChipStyle(header);

    const rowRender = ({ index, style, key, parent }: ListRowProps) => {
      const issue = issues[index];

      if (!issue) {
        return null;
      }

      const draggableId = draggableIdFor(id, issue.id);

      return (
        <Draggable
          key={draggableId}
          draggableId={draggableId}
          index={index}
          isDragDisabled={readOnly}
        >
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
        droppableId={id}
        type="BoardColumn"
        mode="virtual"
        ignoreContainerClipping
        renderClone={(provided, snapshot) => (
          <BoardIssueItem
            issueId={issueIdOfDraggable(
              provided.draggableProps['data-rfd-draggable-id'],
            )}
            isDragging={snapshot.isDragging}
            provided={provided}
          />
        )}
      >
        {(
          droppableProvided: DroppableProvided,
          snapshot: DroppableStateSnapshot,
        ) => {
          const itemCount: number = snapshot.isUsingPlaceholder
            ? issues.length + 1
            : issues.length;

          return (
            <div className="flex flex-col max-h-[100%] w-[350px]">
              <div className="flex gap-1 items-center mb-2 w-[310px]">
                <div
                  className={cn(
                    'flex items-center w-fit h-8 px-4 py-2',
                    chip.className,
                  )}
                  style={chip.style}
                >
                  <GroupLabel header={header} />
                </div>

                <div className="rounded-2xl bg-grayAlpha-100 p-1.5 px-2 font-mono">
                  {issues.length}
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
