import type { FilterPickerProps } from './types';

import { observer } from 'mobx-react-lite';

import { IssueAssigneeDropdownContent } from 'modules/issues/components';

import { useUsersData } from 'hooks/users';

export const IssueAssigneeFilter = observer(
  ({ value, onChange, onClose }: FilterPickerProps) => {
    const { users } = useUsersData(false);

    return (
      <IssueAssigneeDropdownContent
        onChange={(ids: string[]) => onChange(ids)}
        onClose={onClose}
        users={users}
        value={value as string[]}
        multiple
      />
    );
  },
);
