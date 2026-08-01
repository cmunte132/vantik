import { RiListUnordered, RiStackLine } from '@remixicon/react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@vantikhq/ui/components/select';
import { observer } from 'mobx-react-lite';

import { withoutArchived } from 'modules/product-axis/archive';

import { useProject } from 'hooks/projects';
import { useCurrentTeam } from 'hooks/teams';

import { useContextStore } from 'store/global-context-provider';

export const GroupingOrderingOptions = observer(() => {
  const { applicationStore, modulesStore, capabilitiesStore } =
    useContextStore();
  const project = useProject();
  const team = useCurrentTeam();

  // A workspace that has built no module yet would get one group called "No
  // module", which reads as a fault. The option arrives with the first module.
  const hasModules = withoutArchived(modulesStore.getModules).length > 0;
  const hasCapabilities =
    withoutArchived(capabilitiesStore.getCapabilities).length > 0;

  return (
    <div className="flex items-center gap-2">
      <Select
        value={applicationStore.displaySettings.grouping}
        onValueChange={(value: string) => {
          applicationStore.updateDisplaySettings({
            grouping: value,
          });
        }}
      >
        <SelectTrigger className="h-7 py-1 flex gap-1 items-center">
          <RiStackLine size={16} />
          <SelectValue placeholder="Select a category" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel className="text-xs font-normal">Group by</SelectLabel>
            <SelectItem value="status">Status</SelectItem>
            <SelectItem value="assignee">Assignee</SelectItem>
            <SelectItem value="priority">Priority</SelectItem>
            <SelectItem value="label">Label</SelectItem>
            {!project && <SelectItem value="project">Project</SelectItem>}
            {!team && <SelectItem value="team">Team</SelectItem>}
            {hasModules && <SelectItem value="module">Module</SelectItem>}
            {hasCapabilities && (
              <SelectItem value="capability">Capability</SelectItem>
            )}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Select
        value={applicationStore.displaySettings.ordering}
        onValueChange={(value: string) => {
          applicationStore.updateDisplaySettings({
            ordering: value,
          });
        }}
      >
        <SelectTrigger className="h-7 py-1 flex gap-1 items-center">
          <RiListUnordered size={16} />
          <SelectValue placeholder="Select a category" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel className="text-xs font-normal">Order by</SelectLabel>

            <SelectItem value="status">Status</SelectItem>
            <SelectItem value="assignee">Assignee</SelectItem>
            <SelectItem value="priority">Priority</SelectItem>
            <SelectItem value="updated_at">Last updated</SelectItem>
            <SelectItem value="created_at">Last created</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
});
