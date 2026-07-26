'use client';

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';
import { cn } from '../../lib/utils';

/**
 * Sidebar primitives, following shadcn's `Sidebar` naming and prop shapes so a
 * sidebar block's JSX drops in with only styling to reconcile.
 *
 * This covers the composition the app actually renders: header, content,
 * footer, groups, menus and one level of submenu. The offcanvas/mobile-sheet,
 * rail and inset machinery is deliberately absent — nothing uses it yet, and
 * adding it later is additive rather than a rewrite, because these components
 * keep the names it expects.
 *
 * Collapse state lives in the application store rather than shadcn's cookie, so
 * `SidebarProvider` takes `open` as a controlled prop with no internal source of
 * truth to drift from it.
 */

export const SIDEBAR_WIDTH = '248px';

interface SidebarContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleSidebar: () => void;
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

export function useSidebar() {
  const context = React.useContext(SidebarContext);

  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider.');
  }

  return context;
}

export function SidebarProvider({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const value = React.useMemo(
    () => ({
      open,
      setOpen: onOpenChange,
      toggleSidebar: () => onOpenChange(!open),
    }),
    [open, onOpenChange],
  );

  return (
    <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>
  );
}

export const SIDEBAR_WIDTH_ICON = '48px';

export interface SidebarProps extends React.ComponentProps<'div'> {
  /**
   * `icon` narrows to a rail of icons when closed, so navigation is still one
   * click away. `offcanvas` unmounts — right for the settings nav, whose rows
   * have no icons and so have nothing to show in a rail. `none` ignores state.
   */
  collapsible?: 'icon' | 'offcanvas' | 'none';
}

export const Sidebar = React.forwardRef<HTMLDivElement, SidebarProps>(
  ({ className, collapsible = 'none', ...props }, ref) => {
    const { open } = useSidebar();
    const collapsed = collapsible !== 'none' && !open;

    if (collapsible === 'offcanvas' && collapsed) {
      return null;
    }

    return (
      <div
        ref={ref}
        data-sidebar="sidebar"
        data-collapsed={collapsed}
        style={{ width: collapsed ? SIDEBAR_WIDTH_ICON : SIDEBAR_WIDTH }}
        className={cn(
          // Scrolling belongs to SidebarContent, not here, so the footer stays
          // put instead of scrolling away with a long team list.
          'flex h-full shrink-0 flex-col gap-px overflow-hidden p-2',
          'bg-sidebar text-sidebar-foreground text-base',
          className,
        )}
        {...props}
      />
    );
  },
);
Sidebar.displayName = 'Sidebar';

export const SidebarHeader = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-sidebar="header"
    className={cn('flex shrink-0 flex-col gap-px', className)}
    {...props}
  />
));
SidebarHeader.displayName = 'SidebarHeader';

export const SidebarContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-sidebar="content"
    className={cn(
      // `overflow-y-auto` forces overflow-x to `auto` as well — CSS will not
      // scroll one axis and overflow the other — which clipped the active
      // marker where it sits in the gutter. The negative margin plus matching
      // padding buys that gutter back inside the scroll container without
      // shifting the rows.
      'flex min-h-0 flex-1 flex-col gap-px overflow-y-auto -mx-1.5 px-1.5',
      className,
    )}
    {...props}
  />
));
SidebarContent.displayName = 'SidebarContent';

export const SidebarFooter = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-sidebar="footer"
    className={cn(
      'mt-2 flex shrink-0 flex-col border-t border-sidebar-border',
      className,
    )}
    {...props}
  />
));
SidebarFooter.displayName = 'SidebarFooter';

export const SidebarSeparator = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-sidebar="separator"
    className={cn('mx-2 mb-0.5 mt-2.5 h-px bg-sidebar-border', className)}
    {...props}
  />
));
SidebarSeparator.displayName = 'SidebarSeparator';

export const SidebarGroup = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-sidebar="group"
    className={cn('flex flex-col gap-px', className)}
    {...props}
  />
));
SidebarGroup.displayName = 'SidebarGroup';

/**
 * `group/label` so a `SidebarGroupAction` can reveal itself on hover of the
 * whole label row rather than only of the action's own 14px box.
 */
export const SidebarGroupLabel = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-sidebar="group-label"
    className={cn(
      'group/label mt-4 flex h-7 items-center px-2',
      'text-xs font-semibold uppercase tracking-[0.07em] text-sidebar-muted',
      className,
    )}
    {...props}
  />
));
SidebarGroupLabel.displayName = 'SidebarGroupLabel';

export const SidebarGroupAction = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<'button'> & { asChild?: boolean }
>(({ className, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';

  return (
    <Comp
      ref={ref}
      data-sidebar="group-action"
      className={cn(
        'ml-auto flex items-center rounded-sm text-sidebar-muted',
        'opacity-0 transition-opacity hover:text-sidebar-foreground',
        'group-hover/label:opacity-100 focus-visible:opacity-100',
        '[&>svg]:size-3.5 [&>svg]:shrink-0',
        className,
      )}
      {...props}
    />
  );
});
SidebarGroupAction.displayName = 'SidebarGroupAction';

export const SidebarMenu = React.forwardRef<
  HTMLUListElement,
  React.ComponentProps<'ul'>
>(({ className, ...props }, ref) => (
  <ul
    ref={ref}
    data-sidebar="menu"
    className={cn('flex w-full min-w-0 flex-col gap-px', className)}
    {...props}
  />
));
SidebarMenu.displayName = 'SidebarMenu';

export const SidebarMenuItem = React.forwardRef<
  HTMLLIElement,
  React.ComponentProps<'li'>
>(({ className, ...props }, ref) => (
  <li
    ref={ref}
    data-sidebar="menu-item"
    className={cn('group/item relative', className)}
    {...props}
  />
));
SidebarMenuItem.displayName = 'SidebarMenuItem';

/**
 * Rows are transparent at rest and muted, so the eye lands on the one row that
 * is active. `sidebar-marker` (custom.css) draws the logo's dot-dot-dash on the
 * leading edge of that row.
 */
const sidebarMenuButtonVariants = cva(
  cn(
    // No `overflow-hidden` here: the marker is drawn outside the row's box, and
    // clipping it hides the active indicator entirely. Long labels are handled
    // by `truncate` on the label span instead.
    'relative flex w-full items-center gap-[9px] rounded-sm px-2',
    'text-left text-base text-sidebar-muted outline-none transition-colors',
    'hover:bg-sidebar-hover hover:text-sidebar-foreground',
    'focus-visible:ring-1 focus-visible:ring-ring',
    'data-[active=true]:bg-sidebar-active data-[active=true]:font-medium',
    'data-[active=true]:text-sidebar-foreground',
    '[&>svg]:size-4 [&>svg]:shrink-0',
  ),
  {
    variants: {
      size: {
        default: 'h-8',
        sm: 'h-[30px]',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
);

export interface SidebarMenuButtonProps
  extends
    React.ComponentProps<'button'>,
    VariantProps<typeof sidebarMenuButtonVariants> {
  asChild?: boolean;
  isActive?: boolean;
  /** Draws the brand marker on the leading edge while active. */
  marker?: boolean;
  /** Shown on hover once the sidebar is a rail and the label is hidden. */
  tooltip?: string;
}

export const SidebarMenuButton = React.forwardRef<
  HTMLButtonElement,
  SidebarMenuButtonProps
>(
  (
    {
      className,
      asChild = false,
      isActive = false,
      marker = true,
      tooltip,
      size,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : 'button';
    const { open } = useSidebar();

    const button = (
      <Comp
        ref={ref}
        data-sidebar="menu-button"
        data-active={isActive}
        className={cn(
          sidebarMenuButtonVariants({ size }),
          isActive && marker && 'sidebar-marker',
          className,
        )}
        {...props}
      />
    );

    // Only while collapsed: with the label visible a tooltip just repeats it.
    if (!tooltip || open) {
      return button;
    }

    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="right" className="p-2">
          <span>{tooltip}</span>
        </TooltipContent>
      </Tooltip>
    );
  },
);
SidebarMenuButton.displayName = 'SidebarMenuButton';

/**
 * `unread` is the only place colour is spent in the sidebar, because unread is
 * the only count that is genuinely different in kind from the others.
 */
const sidebarMenuBadgeVariants = cva(
  'ml-auto flex shrink-0 items-center justify-center tabular-nums',
  {
    variants: {
      variant: {
        count: 'text-xs text-sidebar-muted',
        unread: cn(
          'h-[17px] min-w-[18px] rounded-full px-1.5',
          'bg-sidebar-brand text-sidebar-brand-foreground',
          'text-[10px] font-semibold',
        ),
      },
    },
    defaultVariants: {
      variant: 'count',
    },
  },
);

export const SidebarMenuBadge = React.forwardRef<
  HTMLSpanElement,
  React.ComponentProps<'span'> & VariantProps<typeof sidebarMenuBadgeVariants>
>(({ className, variant, ...props }, ref) => (
  <span
    ref={ref}
    data-sidebar="menu-badge"
    // Read by the rail rules: a plain count is dropped, unread becomes a dot.
    data-variant={variant ?? 'count'}
    className={cn(sidebarMenuBadgeVariants({ variant }), className)}
    {...props}
  />
));
SidebarMenuBadge.displayName = 'SidebarMenuBadge';

/**
 * The guide line sits at 16px, which is the centre of a parent row's icon, so
 * the nesting is legible without any extra indent on the label.
 */
export const SidebarMenuSub = React.forwardRef<
  HTMLUListElement,
  React.ComponentProps<'ul'>
>(({ className, ...props }, ref) => (
  <ul
    ref={ref}
    data-sidebar="menu-sub"
    className={cn(
      'ml-4 flex min-w-0 flex-col gap-px border-l border-sidebar-border pl-[15px]',
      className,
    )}
    {...props}
  />
));
SidebarMenuSub.displayName = 'SidebarMenuSub';

export const SidebarMenuSubItem = React.forwardRef<
  HTMLLIElement,
  React.ComponentProps<'li'>
>(({ className, ...props }, ref) => (
  <li ref={ref} data-sidebar="menu-sub-item" className={className} {...props} />
));
SidebarMenuSubItem.displayName = 'SidebarMenuSubItem';

export const SidebarMenuSubButton = React.forwardRef<
  HTMLAnchorElement,
  React.ComponentProps<'a'> & { asChild?: boolean; isActive?: boolean }
>(({ className, asChild = false, isActive = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'a';

  return (
    <Comp
      ref={ref}
      data-sidebar="menu-sub-button"
      data-active={isActive}
      className={cn(
        'flex h-[30px] w-full items-center gap-2 overflow-hidden rounded-sm px-2',
        'text-base text-sidebar-muted outline-none transition-colors',
        'hover:bg-sidebar-hover hover:text-sidebar-foreground',
        'focus-visible:ring-1 focus-visible:ring-ring',
        'data-[active=true]:bg-sidebar-active data-[active=true]:font-medium',
        'data-[active=true]:text-sidebar-foreground',
        '[&>svg]:size-3.5 [&>svg]:shrink-0',
        className,
      )}
      {...props}
    />
  );
});
SidebarMenuSubButton.displayName = 'SidebarMenuSubButton';
