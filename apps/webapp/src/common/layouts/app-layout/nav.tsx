'use client';

import {
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@vantikhq/ui/components/sidebar';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';

export interface Link {
  title: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon?: any;
  href: string;
  count?: number;
  /**
   * Renders the count as the brand pill rather than a plain numeral. Reserved
   * for counts that are genuinely different in kind — unread, not "how many".
   */
  unread?: boolean;
  strict?: boolean;
  activePaths?: string[];
}

interface NavProps {
  links: Link[];
}

export function checkIsActive(
  pathname: string,
  href: string,
  activePaths: string[],
  strict: boolean = false,
): boolean {
  if (strict) {
    return pathname.endsWith(href);
  }

  if (pathname.includes(href)) {
    return true;
  }

  if (activePaths && activePaths.length > 0) {
    return (
      activePaths.filter((path: string) => {
        return pathname.includes(path);
      }).length > 0
    );
  }

  return false;
}

export function Nav({ links }: NavProps) {
  const pathname = usePathname();

  return (
    <SidebarMenu>
      {links.map((link) => {
        const isActive = checkIsActive(
          pathname,
          link.href,
          link.activePaths,
          link.strict,
        );

        return (
          <SidebarMenuItem key={link.href}>
            <SidebarMenuButton asChild isActive={isActive} tooltip={link.title}>
              <NextLink href={link.href}>
                {link.icon && <link.icon />}
                <span className="flex-1 truncate">{link.title}</span>
                {/*
                  The count lives inside the link, so it sits on the row's
                  trailing edge instead of tracking the label's width, and it
                  is part of the same hit target.
                */}
                {link.count > 0 && (
                  <SidebarMenuBadge variant={link.unread ? 'unread' : 'count'}>
                    {link.count}
                  </SidebarMenuBadge>
                )}
              </NextLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}
