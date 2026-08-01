import { RiAddLine } from '@remixicon/react';
import { Badge } from '@vantikhq/ui/components/badge';
import { Button } from '@vantikhq/ui/components/button';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import NextLink from 'next/link';
import { useRouter } from 'next/router';
import React from 'react';

import { AppLayout } from 'common/layouts/app-layout';
import { MainLayout } from 'common/layouts/main-layout';
import { SCOPES } from 'common/scopes';
import type { ModuleType } from 'common/types';
import { workspaceHref } from 'common/workspace-href';
import { withApplicationStore } from 'common/wrappers/with-application-store';

import { useScope } from 'hooks';
import { useProduct, useProductModules } from 'hooks/product-axis';

import {
  useCreateModuleMutation,
  useDeleteProductMutation,
  useUpdateProductMutation,
} from 'services/product-axis';

import { statusAfterArchive } from './archive';
import { AxisIcon } from './axis-icon';
import { Header } from './header';
import { IdentityCard } from './identity-card';
import { InlineCreate } from './inline-create';
import { Section } from './section';

/**
 * One product: what it is, and what it is made of.
 *
 * Deliberately not an issue list. Issues belong to teams, and anyone who wants
 * them filtered by product can save a view. This page answers the question
 * nothing else answers: what does this product consist of.
 */
export const ProductView = withApplicationStore(
  observer(() => {
    useScope(SCOPES.AllIssues);

    const product = useProduct();
    const modules = useProductModules(product?.id);
    const router = useRouter();
    const { workspaceSlug } = router.query;

    // The sidebar's add control lands here with the create row already open, so
    // one click from anywhere in the app starts a module.
    const [creating, setCreating] = React.useState(
      router.query.new === 'module',
    );
    const [error, setError] = React.useState<string | undefined>();

    const { mutate: createModule } = useCreateModuleMutation({});
    const { mutate: updateProduct } = useUpdateProductMutation({});
    const { mutate: deleteProduct } = useDeleteProductMutation({});

    if (!product) {
      return <h2>No product found</h2>;
    }

    const owned = modules.filter(
      (module: ModuleType) => module.ownerProductId === product.id,
    );
    const borrowed = modules.filter(
      (module: ModuleType) => module.ownerProductId !== product.id,
    );

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
              { title: product.name },
            ]}
          />
        }
      >
        <div className="flex flex-col gap-6 p-6 max-w-3xl">
          <IdentityCard
            kind="product"
            name={product.name}
            icon={product.icon}
            color={product.color}
            description={product.description}
            status={product.status}
            error={error}
            onRename={(name) => updateProduct({ productId: product.id, name })}
            onIcon={(value) =>
              updateProduct({ productId: product.id, ...value })
            }
            onArchive={(archive) =>
              updateProduct({
                productId: product.id,
                status: statusAfterArchive('product', archive),
              })
            }
            deleteWarning={
              owned.length > 0
                ? `This product owns ${owned.length} module${owned.length === 1 ? '' : 's'}. Give each one a new owner first — a module cannot be left without one.`
                : 'The product goes. Any module that only links to it keeps working.'
            }
            onDelete={() =>
              deleteProduct(
                { productId: product.id },
                {
                  onError: (response: { errors?: { message?: string } }) =>
                    setError(
                      response?.errors?.message ??
                        'That product could not be deleted.',
                    ),
                  onSuccess: () =>
                    router.push(workspaceHref(workspaceSlug, 'products')),
                },
              )
            }
          />

          <Section
            title="Modules"
            description="Where this product's code lives. A module is usually one repository, or one path inside a bigger one."
            action={
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
          >
            {creating && (
              <InlineCreate
                placeholder="Module name, for example Server"
                onCreate={(name) =>
                  createModule({ name, ownerProductId: product.id })
                }
                onClose={() => setCreating(false)}
              />
            )}

            {owned.length === 0 && borrowed.length === 0 && !creating ? (
              <p className="px-4 py-3 text-muted-foreground">
                This product has no modules yet.
              </p>
            ) : (
              <>
                {owned.map((module: ModuleType) => (
                  <ModuleRow
                    key={module.id}
                    module={module}
                    href={workspaceHref(workspaceSlug, 'module', module.key)}
                  />
                ))}

                {/*
                  Borrowed code, listed apart from owned code. A link carries no
                  authority, and reading the two in one list is what makes people
                  think a product owns something it only uses.
                */}
                {borrowed.map((module: ModuleType) => (
                  <ModuleRow
                    key={module.id}
                    module={module}
                    href={workspaceHref(workspaceSlug, 'module', module.key)}
                    borrowed
                  />
                ))}
              </>
            )}
          </Section>
        </div>
      </MainLayout>
    );
  }),
);

function ModuleRow({
  module,
  href,
  borrowed,
}: {
  module: ModuleType;
  href: string;
  borrowed?: boolean;
}) {
  return (
    <NextLink
      href={href}
      className={cn(
        'flex items-center gap-2 border-b border-border px-4 py-2 last:border-b-0 hover:bg-grayAlpha-100',
        borrowed && 'opacity-70',
      )}
    >
      <AxisIcon
        kind="module"
        name={module.name}
        icon={module.icon}
        color={module.color}
      />
      <span className="flex-1 truncate">{module.name}</span>
      <span className="text-muted-foreground">{module.key}</span>
      {borrowed && <Badge variant="outline">linked</Badge>}
    </NextLink>
  );
}

ProductView.getLayout = function getLayout(page: React.ReactElement) {
  return <AppLayout>{page}</AppLayout>;
};
