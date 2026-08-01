'use client';

import { RiAddLine, RiArrowRightSLine } from '@remixicon/react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@vantikhq/ui/components/collapsible';
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@vantikhq/ui/components/sidebar';
import { observer } from 'mobx-react-lite';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import { withoutArchived } from 'modules/product-axis/archive';
import { AxisIcon } from 'modules/product-axis/axis-icon';

import type { ModuleType, ProductType } from 'common/types';

import { useCurrentWorkspace } from 'hooks/workspace';

import { useContextStore } from 'store/global-context-provider';

import { ModuleRow, useIssueCountByModule } from './module-row';
import { checkIsActive } from './nav';

/**
 * The products a workspace ships, above the teams that build them.
 *
 * The row opens and closes the way a team row does, and the chevron beside it
 * says so. It also navigates, because a product has a page of its own — the
 * chevron swallows its own click so the two never fight.
 *
 * There is no Capabilities row. A capability belongs to modules and not to a
 * product, so a fixed row for it here would claim otherwise; it is read on the
 * product page instead.
 */
export const ProductList = observer(() => {
  const { productsStore, modulesStore } = useContextStore();
  const pathname = usePathname();
  const workspace = useCurrentWorkspace();

  const [toggled, setToggled] = React.useState<Record<string, boolean>>({});

  // An archived product leaves the sidebar. Its page stays reachable, and
  // `withoutArchived` is what every list a person picks from uses.
  const products = withoutArchived<ProductType>(productsStore.getProducts);
  const countByModule = useIssueCountByModule();

  return (
    <SidebarGroup>
      <SidebarGroupLabel>
        Products
        <SidebarGroupAction asChild aria-label="Add product">
          <NextLink href={`/${workspace.slug}/settings/new_product`}>
            <RiAddLine size={18} />
          </NextLink>
        </SidebarGroupAction>
      </SidebarGroupLabel>

      <SidebarMenu>
        {products.map((product: ProductType) => {
          const owned: ModuleType[] = withoutArchived<ModuleType>(
            modulesStore.getModulesOwnedByProduct(product.id),
          );
          const linked: ModuleType[] = withoutArchived<ModuleType>(
            modulesStore.getModulesLinkedToProduct(product.id),
          );
          const modules = [...owned, ...linked];

          const productHref = `/${workspace.slug}/product/${product.key}`;
          const moduleHref = (module: ModuleType) =>
            `/${workspace.slug}/module/${module.key}`;

          const onProduct = checkIsActive(pathname, productHref, []);
          const onChild = modules
            .map(moduleHref)
            .some((href) => checkIsActive(pathname, href, []));

          return (
            <Collapsible
              key={product.id}
              open={toggled[product.id] ?? (onProduct || onChild)}
              onOpenChange={(open) =>
                setToggled((previous) => ({ ...previous, [product.id]: open }))
              }
              className="group/collapsible"
            >
              <SidebarMenuItem>
                <CollapsibleTrigger asChild>
                  {/*
                    The product row opens and closes, and does not navigate —
                    the same as a team row, and for the same reason: a row that
                    toggles carries no brand marker, because that marker means
                    "the page you are on". The product's own page is reached
                    from the Products list.
                  */}
                  <SidebarMenuButton
                    isActive={onProduct || onChild}
                    tooltip={product.name}
                  >
                    <AxisIcon
                      kind="product"
                      name={product.name}
                      icon={product.icon}
                      color={product.color}
                      size="md"
                    />
                    <span className="flex-1 truncate">{product.name}</span>
                    <span data-rail-hide className="flex shrink-0">
                      <RiArrowRightSLine
                        className="!size-3.5 text-sidebar-muted transition-transform
                          duration-200 group-data-[state=open]/collapsible:rotate-90"
                        size={16}
                      />
                    </span>
                  </SidebarMenuButton>
                </CollapsibleTrigger>

                <CollapsibleContent>
                  <SidebarMenuSub>
                    {owned.map((module) => (
                      <ModuleRow
                        key={module.id}
                        module={module}
                        href={moduleHref(module)}
                        pathname={pathname}
                        count={countByModule.get(module.id) ?? 0}
                      />
                    ))}

                    {/*
                      A module this product links but does not own. It renders
                      dimmed and says "linked" where the others show a count, so
                      borrowed code reads as borrowed.
                    */}
                    {linked.map((module) => (
                      <ModuleRow
                        key={module.id}
                        module={module}
                        href={moduleHref(module)}
                        pathname={pathname}
                        borrowed
                      />
                    ))}

                    {/*
                      Under the last module, where the next one would go, and
                      always on screen. Hiding it until hover reserved a blank
                      row anyway, and a control nobody knows to hover over is no
                      way out of a product that has no modules yet.
                    */}
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton asChild>
                        <NextLink
                          href={`${productHref}?new=module`}
                          className="text-sidebar-muted"
                        >
                          <RiAddLine className="!size-3.5" size={18} />
                          <span className="flex-1 truncate">New module</span>
                        </NextLink>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  </SidebarMenuSub>
                </CollapsibleContent>
              </SidebarMenuItem>
            </Collapsible>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
});
