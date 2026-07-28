import type { DropResult } from '@hello-pangea/dnd';

import { Board } from '@vantikhq/ui/components/board';
import { sort } from 'fast-sort';
import { observer } from 'mobx-react-lite';

import { useUpdateIssueMutation } from 'services/issues';

import { useContextStore } from 'store/global-context-provider';

import { AxisBoardList } from './axis-board-list';
import { moduleIdsAfterDrag, NO_GROUP, type AxisGrouping } from './utils';

interface AxisBoardProps {
  grouping: AxisGrouping;
}

/**
 * The board of the second axis, with one column for each module or capability.
 *
 * A drag writes the axis of the issue. An issue can name several modules, so a
 * drag between two module columns removes the first and adds the second, and it
 * leaves the modules that no column showed alone. A capability is one field, so
 * a drag replaces it.
 */
export const AxisBoard = observer(({ grouping }: AxisBoardProps) => {
  const { mutate: updateIssue } = useUpdateIssueMutation({});
  const { issuesStore } = useContextStore();

  const onDragEnd = (result: DropResult) => {
    if (!result.destination) {
      return;
    }

    // The draggable id carries the column, because one issue can sit in two of
    // them. The part after the separator is the issue.
    const issueId = result.draggableId.includes('__')
      ? result.draggableId.split('__')[1]
      : result.draggableId;

    const issue = issuesStore.getIssueById(issueId);

    if (!issue) {
      return;
    }

    const from = result.source.droppableId;
    const to = result.destination.droppableId;

    if (from === to) {
      return;
    }

    if (grouping.isArray) {
      updateIssue({
        id: issue.id,
        teamId: issue.teamId,
        moduleIds: moduleIdsAfterDrag([...(issue.moduleIds ?? [])], from, to),
      });

      return;
    }

    updateIssue({
      id: issue.id,
      teamId: issue.teamId,
      capabilityId: to === NO_GROUP ? null : to,
    });
  };

  const groups = sort(grouping.groups).asc((group) => group.name);

  return (
    <Board onDragEnd={onDragEnd} className="pl-4">
      <>
        {groups.map((group) => (
          <AxisBoardList key={group.id} grouping={grouping} group={group} />
        ))}

        <AxisBoardList grouping={grouping} />
      </>
    </Board>
  );
});
