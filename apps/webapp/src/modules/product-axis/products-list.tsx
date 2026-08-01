import { RiAddLine, RiDeleteBinLine } from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import { observer } from 'mobx-react-lite';
import NextLink from 'next/link';
import { useRouter } from 'next/router';
import React from 'react';

import { AppLayout } from 'common/layouts/app-layout';
import { MainLayout } from 'common/layouts/main-layout';
import { SCOPES } from 'common/scopes';
import type { ModuleType, ProductType } from 'common/types';
import { workspaceHref } from 'common/workspace-href';
import { withApplicationStore } from 'common/wrappers/with-application-store';

import { RecordTable } from 'components/record-table';
import { useScope } from 'hooks';

import {
  useCreateModuleMutation,
  useDeleteModuleMutation,
  useUpdateModuleMutation,
} from 'services/product-axis';

import { useContextStore } from 'store/global-context-provider';

import { Header } from './header';
import { InlineCreate } from './inline-create';
import { OwnerSelect, type Owner } from './owner-select';
import { useProductColumns } from './products-list/columns';

/**
 * The products of a workspace: the same table the teams list uses.
 *
 * A product and a team are the two axes of a workspace, so the two lists are
 * one table with different columns. A row opens the product, the way a team row
 * opens the team.
 *
 * A product is made on its own page, the same way a team is. A row at the top
 * of this list held a name field and nothing else, and a product also takes a
 * description and an identifier. The header sends the reader to that form.
 */
export const Products = withApplicationStore(
  observer(() => {
    useScope(SCOPES.AllIssues);

    const { productsStore } = useContextStore();
    const router = useRouter();
    const { workspaceSlug } = router.query;

    const [error, setError] = React.useState<string | undefined>();

    // react-table keeps `data` by reference and reads it as a plain array. An
    // MST array is neither, so it has to be copied out — the same reason the
    // teams list does. The spread also gives a new reference on every change,
    // which is what makes the table re-render.
    const products: ProductType[] = [...productsStore.getProducts];
    const columns = useProductColumns(setError);

    return (
      <MainLayout
        scrollable
        header={
          <Header
            crumbs={[{ title: 'Products' }]}
            actions={
              <Button variant="secondary" size="sm" className="gap-1" asChild>
                <NextLink
                  href={workspaceHref(workspaceSlug, 'settings', 'new_product')}
                >
                  <RiAddLine size={14} />
                  New product
                </NextLink>
              </Button>
            }
          />
        }
      >
        {error && (
          <div className="px-4 py-2 text-destructive text-sm">{error}</div>
        )}

        <RecordTable<ProductType>
          data={products}
          columns={columns}
          onRowClick={(product) =>
            router.push(workspaceHref(workspaceSlug, 'product', product.key))
          }
          empty={
            <span className="text-muted-foreground">
              No products yet. A product is what you ship, and it groups the
              modules that hold the code.
            </span>
          }
        />
      </MainLayout>
    );
  }),
);

Products.getLayout = function getLayout(page: React.ReactElement) {
  return <AppLayout>{page}</AppLayout>;
};

/** Every module in the workspace, with its owner editable in place. */
export const Modules = withApplicationStore(
  observer(() => {
    useScope(SCOPES.AllIssues);

    const { modulesStore, productsStore, teamsStore } = useContextStore();
    const {
      query: { workspaceSlug },
    } = useRouter();

    const [creating, setCreating] = React.useState(false);
    const [owner, setOwner] = React.useState<Owner>({
      ownerTeamId: null,
      ownerProductId: null,
    });

    const { mutate: createModule } = useCreateModuleMutation({});
    const { mutate: updateModule } = useUpdateModuleMutation({});
    const { mutate: deleteModule } = useDeleteModuleMutation({});

    const modules: ModuleType[] = modulesStore.getModules;
    const hasOwner = Boolean(owner.ownerTeamId || owner.ownerProductId);

    const ownerName = (module: ModuleType) => {
      const found = module.ownerProductId
        ? productsStore.getProductWithId(module.ownerProductId)
        : teamsStore.getTeamWithId(module.ownerTeamId);

      return found?.name ?? 'Nobody';
    };

    return (
      <MainLayout
        scrollable
        header={
          <Header
            crumbs={[{ title: 'Modules' }]}
            actions={
              <Button
                variant="secondary"
                size="sm"
                className="gap-1"
                onClick={() => setCreating(true)}
              >
                <RiAddLine size={14} />
                New module
              </Button>
            }
          />
        }
      >
        {creating && (
          <InlineCreate
            placeholder="Module name, for example Server"
            disabled={!hasOwner}
            onCreate={(name) =>
              createModule({
                name,
                ...(owner.ownerProductId
                  ? { ownerProductId: owner.ownerProductId }
                  : { ownerTeamId: owner.ownerTeamId }),
              })
            }
            onClose={() => setCreating(false)}
          >
            {/*
              A module cannot exist without exactly one owner, so the control for
              it sits in the create row and not behind a later edit.
            */}
            <div className="w-64 shrink-0">
              <OwnerSelect value={owner} onChange={setOwner} />
            </div>
          </InlineCreate>
        )}

        {modules.length === 0 && !creating ? (
          <div className="px-4 py-6 text-muted-foreground">
            No modules yet. A module is usually one repository. It belongs to a
            team when it holds internal tools, and to a product when it ships to
            customers.
          </div>
        ) : (
          <div className="flex flex-col">
            {modules.map((module) => (
              <div
                key={module.id}
                className="flex items-center gap-2 border-b border-border px-4 py-2"
              >
                <NextLink
                  href={workspaceHref(workspaceSlug, 'module', module.key)}
                  className="flex flex-1 items-center gap-2 min-w-0 hover:underline"
                >
                  <span className="flex-1 truncate">{module.name}</span>
                  <span className="text-muted-foreground">{module.key}</span>
                </NextLink>

                <div className="w-64 shrink-0">
                  <OwnerSelect
                    value={{
                      ownerTeamId: module.ownerTeamId ?? null,
                      ownerProductId: module.ownerProductId ?? null,
                    }}
                    onChange={(next) =>
                      updateModule({ moduleId: module.id, ...next })
                    }
                  />
                </div>

                <span className="text-muted-foreground w-28 truncate">
                  {ownerName(module)}
                </span>

                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Delete ${module.name}`}
                  onClick={() => deleteModule({ moduleId: module.id })}
                >
                  <RiDeleteBinLine size={14} />
                </Button>
              </div>
            ))}
          </div>
        )}
      </MainLayout>
    );
  }),
);

Modules.getLayout = function getLayout(page: React.ReactElement) {
  return <AppLayout>{page}</AppLayout>;
};
