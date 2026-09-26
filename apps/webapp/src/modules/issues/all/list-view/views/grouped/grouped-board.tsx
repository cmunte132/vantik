import type { Grouping } from './grouping';
import type { DropResult } from '@hello-pangea/dnd';

import { Board } from '@vantikhq/ui/components/board';
import { observer } from 'mobx-react-lite';

import { useCompletionGuard } from 'modules/issues/components/use-completion-guard';

import type { IssueType } from 'common/types';

import { useUpdateIssueMutation } from 'services/issues';

import { useContextStore } from 'store/global-context-provider';

import { BoardColumn } from './board-column';
import {
  changeForDrop,
  issueIdOfDraggable,
  NO_GROUP,
  sortIntoGroups,
} from './grouping';

interface GroupedBoardProps {
  grouping: Grouping;
  issues: IssueType[];
}

/** The issues of the page, in a column for each group. A drag writes the group. */
export const GroupedBoard = observer(
  ({ grouping, issues }: GroupedBoardProps) => {
    const { mutate: updateIssue } = useUpdateIssueMutation({});
    const { issuesStore } = useContextStore();
    const { guard, dialog } = useCompletionGuard();

    const sections = sortIntoGroups(issues, grouping);

    const onDragEnd = (result: DropResult) => {
      if (!result.destination) {
        return;
      }

      const issue = issuesStore.getIssueById(
        issueIdOfDraggable(result.draggableId),
      );

      if (!issue) {
        return;
      }

      const change = changeForDrop(
        issue,
        grouping,
        result.source.droppableId,
        result.destination.droppableId,
      );

      if (!change) {
        return;
      }

      const apply = () =>
        updateIssue({ id: issue.id, teamId: issue.teamId, ...change });

      // Dragging a card into a Done column completes the issue as surely as the
      // status dropdown does, so it asks the same question first.
      if (change.stateId) {
        guard(issue.id, change.stateId, apply);
      } else {
        apply();
      }
    };

    return (
      <Board onDragEnd={onDragEnd} className="pl-4">
        <>
          {dialog}
          {grouping.groups.map((group) => (
            <BoardColumn
              key={group.id}
              id={group.id}
              header={group}
              issues={sections.get(group.id)}
              readOnly={grouping.readOnly}
            />
          ))}

          {grouping.empty && (
            <BoardColumn
              id={NO_GROUP}
              header={grouping.empty}
              issues={sections.get(NO_GROUP)}
              readOnly={grouping.readOnly}
            />
          )}
        </>
      </Board>
    );
  },
);
