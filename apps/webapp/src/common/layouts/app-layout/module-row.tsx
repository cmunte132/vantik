'use client';

import {
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@vantikhq/ui/components/sidebar';
import { cn } from '@vantikhq/ui/lib/utils';
import NextLink from 'next/link';
import * as React from 'react';

import { AxisIcon } from 'modules/product-axis/axis-icon';

import type { IssueType, ModuleType } from 'common/types';

import { useContextStore } from 'store/global-context-provider';

import { checkIsActive } from './nav';

/**
 * A module in the sidebar.
 *
 * A product owns modules and so does a team, and the row is the same row in
 * both places. A module the owner only links renders dimmed and says `linked`
 * where an owned one shows its count, so borrowed code reads as borrowed.
 */

interface ModuleRowProps {
  module: ModuleType;
  href: string;
  pathname: string;
  count?: number;
  borrowed?: boolean;
}

export function ModuleRow({
  module,
  href,
  pathname,
  count,
  borrowed,
}: ModuleRowProps) {
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        asChild
        isActive={checkIsActive(pathname, href, [])}
      >
        <NextLink href={href} className={cn(borrowed && 'opacity-60')}>
          <AxisIcon
            kind="module"
            name={module.name}
            icon={module.icon}
            color={module.color}
            size="sm"
            className={cn(borrowed && 'opacity-70')}
          />
          <span className="flex-1 truncate">{module.name}</span>
          <span data-rail-hide className="shrink-0 text-sidebar-muted">
            {borrowed ? 'linked' : count || null}
          </span>
        </NextLink>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

/**
 * This hook counts the issues of each module, once for the whole sidebar.
 *
 * A row that counted its own issues would walk the whole issue list again, and
 * a workspace has one issue list and many modules.
 */
export function useIssueCountByModule(): Map<string, number> {
  const { issuesStore } = useContextStore();
  const issues = issuesStore.getIssues({}) as IssueType[];

  return React.useMemo(() => countIssuesByModule(issues), [issues]);
}

/**
 * This function counts the issues of each module.
 *
 * An issue can name more than one module, and it counts once for each of them.
 * The number beside a module is what that module has to do, and an issue that
 * changes two modules is work for both.
 */
export function countIssuesByModule(issues: IssueType[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const issue of issues) {
    for (const moduleId of issue.moduleIds ?? []) {
      counts.set(moduleId, (counts.get(moduleId) ?? 0) + 1);
    }
  }

  return counts;
}
