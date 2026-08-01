import {
  RiAccountCircleLine,
  RiBox3Line,
  RiCodeSSlashLine,
  RiFocus3Line,
  RiPriceTag3Line,
  RiRefreshLine,
} from '@remixicon/react';
import { CommandGroup, CommandItem } from '@vantikhq/ui/components/command';
import { Separator } from '@vantikhq/ui/components/separator';
import {
  BlockedFill,
  BlocksFill,
  ParentIssueLine,
  PriorityHigh,
  SubIssue,
  UnscopedLine,
} from '@vantikhq/ui/icons';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { useProject } from 'hooks/projects';

export const DefaultFilterDropdown = observer(
  ({ onSelect }: { onSelect: (value: string) => void }) => {
    const project = useProject();

    return (
      <CommandGroup>
        <CommandItem
          key="Status"
          value="Status"
          className="flex items-center"
          onSelect={onSelect}
        >
          <UnscopedLine size={16} className="mr-2" /> Status
        </CommandItem>

        <CommandItem
          key="Assignee"
          value="Assignee"
          className="flex items-center"
          onSelect={onSelect}
        >
          <RiAccountCircleLine size={16} className="mr-2" />
          Assignee
        </CommandItem>
        <CommandItem
          key="Label"
          value="Label"
          className="flex items-center"
          onSelect={onSelect}
        >
          <RiPriceTag3Line size={16} className="mr-2" />
          Label
        </CommandItem>
        <CommandItem
          key="Priority"
          value="Priority"
          className="flex items-center"
          onSelect={onSelect}
        >
          <PriorityHigh size={16} className="mr-2" />
          Priority
        </CommandItem>
        <CommandItem
          key="Cycle"
          value="Cycle"
          className="flex items-center"
          onSelect={onSelect}
        >
          <RiRefreshLine size={16} className="mr-2" />
          Cycle
        </CommandItem>
        {!project && (
          <CommandItem
            key="Project"
            value="Project"
            className="flex items-center"
            onSelect={onSelect}
          >
            <RiBox3Line size={16} className="mr-2" />
            Project
          </CommandItem>
        )}

        {/*
          The second axis. A team owns issues, and a module owns code, so these
          three answer a question the filters above cannot: which part of the
          software this work touches.
        */}
        <Separator className="my-1" />
        <CommandItem
          key="Product"
          value="Product"
          className="flex items-center"
          onSelect={onSelect}
        >
          <RiBox3Line size={16} className="mr-2" />
          Product
        </CommandItem>
        <CommandItem
          key="Module"
          value="Module"
          className="flex items-center"
          onSelect={onSelect}
        >
          <RiCodeSSlashLine size={16} className="mr-2" />
          Module
        </CommandItem>
        <CommandItem
          key="Capability"
          value="Capability"
          className="flex items-center"
          onSelect={onSelect}
        >
          <RiFocus3Line size={16} className="mr-2" />
          Capability
        </CommandItem>

        <Separator className="my-1" />
        <CommandItem
          key="parentIssues"
          value="isParent"
          className="flex items-center"
          onSelect={() => onSelect('isParent')}
        >
          <ParentIssueLine size={16} className="mr-2" />
          Parent issues
        </CommandItem>
        <CommandItem
          key="subIssues"
          value="isSubIssue"
          className="flex items-center"
          onSelect={() => onSelect('isSubIssue')}
        >
          <SubIssue size={14} className="mr-2" />
          Sub issues
        </CommandItem>
        <CommandItem
          key="blockedIssues"
          value="isBlocked"
          className="flex items-center"
          onSelect={() => onSelect('isBlocked')}
        >
          <BlockedFill size={16} className="mr-2 text-red-500" />
          Blocked issues
        </CommandItem>
        <CommandItem
          key="blockingIssues"
          value="isBlocking"
          className="flex items-center"
          onSelect={() => onSelect('isBlocking')}
        >
          <BlocksFill size={16} className="mr-2 text-orange-500" />
          Blocking issues
        </CommandItem>
      </CommandGroup>
    );
  },
);
