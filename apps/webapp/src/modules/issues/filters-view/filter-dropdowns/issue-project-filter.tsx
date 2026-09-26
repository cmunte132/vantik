import type { FilterPickerProps } from './types';

import { observer } from 'mobx-react-lite';

import { ProjectDropdownContent } from 'modules/issues/components/issue-metadata/project';

import { useProjects } from 'hooks/projects';

export const IssueProjectFilter = observer(
  ({ value, onChange, onClose }: FilterPickerProps) => {
    const projects = useProjects();

    return (
      <ProjectDropdownContent
        onChange={(ids: string[]) => onChange(ids)}
        onClose={onClose}
        projects={projects}
        value={value as string[]}
        multiple
      />
    );
  },
);
