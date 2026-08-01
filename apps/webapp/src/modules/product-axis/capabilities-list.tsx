import { RiAddLine, RiDeleteBinLine } from '@remixicon/react';
import { Badge } from '@vantikhq/ui/components/badge';
import { Button } from '@vantikhq/ui/components/button';
import { observer } from 'mobx-react-lite';
import NextLink from 'next/link';
import { useRouter } from 'next/router';
import React from 'react';

import { AppLayout } from 'common/layouts/app-layout';
import { MainLayout } from 'common/layouts/main-layout';
import { SCOPES } from 'common/scopes';
import type { CapabilityType, ModuleType } from 'common/types';
import { workspaceHref } from 'common/workspace-href';
import { withApplicationStore } from 'common/wrappers/with-application-store';

import { useScope } from 'hooks';
import { useProduct, useProductModules } from 'hooks/product-axis';

import {
  useCreateCapabilityMutation,
  useDeleteCapabilityMutation,
} from 'services/product-axis';

import { useContextStore } from 'store/global-context-provider';

import { Header } from './header';
import { InlineCreate } from './inline-create';

interface CapabilitiesListProps {
  /** Narrow the list to one product. Without it the whole workspace shows. */
  scopedToProduct?: boolean;
  /**
   * Set on the workspace list, where a capability is created and removed. The
   * product view is a reading of the graph and owns none of these rows, so it
   * offers no delete.
   */
  onDelete?: (capabilityId: string) => void;
}

/**
 * The capabilities of a workspace, or of one product.
 *
 * The product list is derived and stored nowhere. A capability names the modules
 * that hold its code, so the product's capabilities are the ones whose modules
 * that product owns or borrows. Storing the list twice is what would let the two
 * halves disagree.
 */
export const CapabilitiesList = observer(
  ({ scopedToProduct, onDelete }: CapabilitiesListProps) => {
    const { capabilitiesStore, modulesStore } = useContextStore();
    const product = useProduct();
    const productModules = useProductModules(product?.id);
    const {
      query: { workspaceSlug },
    } = useRouter();

    const capabilities: CapabilityType[] = scopedToProduct
      ? capabilitiesStore.getCapabilitiesForModules(
          productModules.map((module: ModuleType) => module.id),
        )
      : capabilitiesStore.getCapabilities;

    if (capabilities.length === 0) {
      return (
        <div className="px-4 py-6 text-muted-foreground">
          {scopedToProduct
            ? 'No capability lives in the modules of this product yet.'
            : 'No capabilities yet.'}
        </div>
      );
    }

    return (
      <div className="flex flex-col">
        {capabilities.map((capability: CapabilityType) => {
          const modules = capability.moduleIds
            .map((id: string) => modulesStore.getModuleWithId(id))
            .filter(Boolean);

          return (
            <div
              key={capability.id}
              className="flex items-center gap-2 border-b border-border px-4 py-2 hover:bg-grayAlpha-100"
            >
              <NextLink
                href={workspaceHref(workspaceSlug, 'capability', capability.id)}
                className="flex flex-1 items-center gap-2 min-w-0"
              >
                <span className="flex-1 truncate">{capability.name}</span>

                <Badge variant="outline">
                  {capability.status ?? 'planned'}
                </Badge>

                {/*
                  An empty list is the honest state of a capability nobody has
                  built. It reads as planned work and not as a broken row.
                */}
                {modules.length === 0 ? (
                  <span className="text-muted-foreground">not built</span>
                ) : (
                  modules.map((module) => (
                    <Badge key={module.id} variant="secondary">
                      {module.name}
                    </Badge>
                  ))
                )}
              </NextLink>

              {onDelete && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Delete ${capability.name}`}
                  onClick={() => onDelete(capability.id)}
                >
                  <RiDeleteBinLine size={14} />
                </Button>
              )}
            </div>
          );
        })}
      </div>
    );
  },
);

export const WorkspaceCapabilities = withApplicationStore(
  observer(() => {
    useScope(SCOPES.AllIssues);

    const [creating, setCreating] = React.useState(false);
    const { mutate: createCapability } = useCreateCapabilityMutation({});
    const { mutate: deleteCapability } = useDeleteCapabilityMutation({});

    return (
      <MainLayout
        scrollable
        header={
          <Header
            crumbs={[{ title: 'Capabilities' }]}
            actions={
              <Button
                variant="secondary"
                size="sm"
                className="gap-1"
                onClick={() => setCreating(true)}
              >
                <RiAddLine size={14} />
                New capability
              </Button>
            }
          />
        }
      >
        {creating && (
          <InlineCreate
            placeholder="Capability name, for example Single sign-on"
            onCreate={(name) => createCapability({ name })}
            onClose={() => setCreating(false)}
          />
        )}

        {/*
          A capability is created with no modules on purpose. It is planned work
          until somebody writes the code, and the modules are set from the
          capability's own page once they exist.
        */}
        <CapabilitiesList
          onDelete={(capabilityId) => deleteCapability({ capabilityId })}
        />
      </MainLayout>
    );
  }),
);

WorkspaceCapabilities.getLayout = function getLayout(page: React.ReactElement) {
  return <AppLayout>{page}</AppLayout>;
};

export const ProductCapabilities = withApplicationStore(
  observer(() => {
    useScope(SCOPES.AllIssues);

    const product = useProduct();
    const {
      query: { workspaceSlug },
    } = useRouter();

    return (
      <MainLayout
        scrollable
        header={
          <Header
            crumbs={[
              {
                title: 'Products',
                href: workspaceHref(workspaceSlug, 'products'),
              },
              {
                title: product?.name ?? 'Product',
                href: product
                  ? workspaceHref(workspaceSlug, 'product', product.key)
                  : undefined,
              },
              { title: 'Capabilities' },
            ]}
          />
        }
      >
        <CapabilitiesList scopedToProduct />
      </MainLayout>
    );
  }),
);

ProductCapabilities.getLayout = function getLayout(page: React.ReactElement) {
  return <AppLayout>{page}</AppLayout>;
};
