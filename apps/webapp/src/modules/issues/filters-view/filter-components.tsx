import type {
  FilterChipProps,
  FilterPickerProps,
} from './filter-dropdowns/types';
import type { ComponentType, ReactNode } from 'react';

import {
  RiAccountCircleLine,
  RiBox3Line,
  RiCodeSSlashLine,
  RiFocus3Line,
  RiPriceTag3Line,
  RiRefreshLine,
} from '@remixicon/react';
import {
  BlockedFill,
  BlocksFill,
  ParentIssueLine,
  PriorityHigh,
  SubIssue,
  UnscopedLine,
} from '@vantikhq/ui/icons';

import type { FlagFilterKey, ValueFilterKey } from 'store/application';

import {
  IssueAssigneeDropdown,
  IssueAssigneeFilter,
  IssueCapabilityDropdown,
  IssueCapabilityFilter,
  IssueCycleDropdown,
  IssueCycleFilter,
  IssueLabelDropdown,
  IssueLabelFilter,
  IssueModuleDropdown,
  IssueModuleFilter,
  IssuePriorityDropdown,
  IssuePriorityFilter,
  IssueProductDropdown,
  IssueProductFilter,
  IssueProjectDropdown,
  IssueProjectFilter,
  IssueStatusDropdown,
  IssueStatusFilter,
} from './filter-dropdowns';

/**
 * How each issue filter is picked and shown. The meaning of each lives in
 * `filter-registry.ts`; this is kept apart because the specs cannot load
 * components. Closed over the same keys, so a filter cannot have one half.
 */

interface ValueFilterComponents {
  icon: ReactNode;
  Picker: ComponentType<FilterPickerProps>;
  Chip: ComponentType<FilterChipProps>;
}

export const VALUE_FILTER_COMPONENTS: Record<
  ValueFilterKey,
  ValueFilterComponents
> = {
  status: {
    icon: <UnscopedLine size={16} className="mr-2" />,
    Picker: IssueStatusFilter,
    Chip: IssueStatusDropdown,
  },
  assignee: {
    icon: <RiAccountCircleLine size={16} className="mr-2" />,
    Picker: IssueAssigneeFilter,
    Chip: IssueAssigneeDropdown,
  },
  label: {
    icon: <RiPriceTag3Line size={16} className="mr-2" />,
    Picker: IssueLabelFilter,
    Chip: IssueLabelDropdown,
  },
  priority: {
    icon: <PriorityHigh size={16} className="mr-2" />,
    Picker: IssuePriorityFilter,
    Chip: IssuePriorityDropdown,
  },
  cycle: {
    icon: <RiRefreshLine size={16} className="mr-2" />,
    Picker: IssueCycleFilter,
    Chip: IssueCycleDropdown,
  },
  project: {
    icon: <RiBox3Line size={16} className="mr-2" />,
    Picker: IssueProjectFilter,
    Chip: IssueProjectDropdown,
  },
  product: {
    icon: <RiBox3Line size={16} className="mr-2" />,
    Picker: IssueProductFilter,
    Chip: IssueProductDropdown,
  },
  module: {
    icon: <RiCodeSSlashLine size={16} className="mr-2" />,
    Picker: IssueModuleFilter,
    Chip: IssueModuleDropdown,
  },
  capability: {
    icon: <RiFocus3Line size={16} className="mr-2" />,
    Picker: IssueCapabilityFilter,
    Chip: IssueCapabilityDropdown,
  },
};

export const FLAG_FILTER_ICONS: Record<FlagFilterKey, ReactNode> = {
  isParent: <ParentIssueLine size={16} className="mr-2" />,
  isSubIssue: <SubIssue size={14} className="mr-2" />,
  isBlocked: <BlockedFill size={16} className="mr-2 text-red-500" />,
  isBlocking: <BlocksFill size={16} className="mr-2 text-orange-500" />,
};
