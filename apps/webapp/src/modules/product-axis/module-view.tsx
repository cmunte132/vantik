import { Badge } from '@vantikhq/ui/components/badge';
import { IssuesLine } from '@vantikhq/ui/icons';
import { observer } from 'mobx-react-lite';
import NextLink from 'next/link';
import { useRouter } from 'next/router';
import React from 'react';

import { AppLayout } from 'common/layouts/app-layout';
import { MainLayout } from 'common/layouts/main-layout';
import { SCOPES } from 'common/scopes';
import type { IssueType, ProductType, TeamType } from 'common/types';
import { workspaceHref } from 'common/workspace-href';
import { withApplicationStore } from 'common/wrappers/with-application-store';

import { useScope } from 'hooks';
import { useProductModule } from 'hooks/product-axis';

import {
  useDeleteModuleMutation,
  useUpdateModuleMutation,
} from 'services/product-axis';

import { useContextStore } from 'store/global-context-provider';

import { statusAfterArchive } from './archive';
import { CapabilityPicker } from './capability-picker';
import { Header } from './header';
import { IdentityCard } from './identity-card';
import { LinkPicker } from './link-picker';
import { OwnerSelect } from './owner-select';
import { Repositories } from './repositories';
import { Section } from './section';

/**
 * One module, in the order somebody reads it: what it is, who is responsible,
 * who else works in it, where its code is, and what it does.
 *
 * Structure first, and issues only as a count. Issues are team-based by nature,
 * so a second filtered list of them here would compete with views without
 * answering anything they do not.
 */
export const ModuleView = withApplicationStore(
  observer(() => {
    useScope(SCOPES.AllIssues);

    const productModule = useProductModule();
    const router = useRouter();
    const { workspaceSlug } = router.query;
    const { productsStore, teamsStore, issuesStore } = useContextStore();

    const { mutate: updateModule } = useUpdateModuleMutation({});
    const { mutate: deleteModule } = useDeleteModuleMutation({});

    if (!productModule) {
      return <h2>No module found</h2>;
    }

    const owner: ProductType | TeamType | undefined =
      productModule.ownerProductId
        ? productsStore.getProductWithId(productModule.ownerProductId)
        : teamsStore.getTeamWithId(productModule.ownerTeamId);

    const issueCount = (issuesStore.getIssues({}) as IssueType[]).filter(
      (issue) => (issue.moduleIds ?? []).includes(productModule.id),
    ).length;

    return (
      <MainLayout
        scrollable
        header={
          <Header
            crumbs={[
              {
                title: 'Modules',
                href: workspaceHref(workspaceSlug, 'modules'),
              },
              { title: productModule.name },
            ]}
          />
        }
      >
        <div className="flex flex-col gap-6 p-6 max-w-3xl">
          <IdentityCard
            kind="module"
            name={productModule.name}
            icon={productModule.icon}
            color={productModule.color}
            description={productModule.description}
            status={productModule.status}
            onRename={(name) =>
              updateModule({ moduleId: productModule.id, name })
            }
            onIcon={(value) =>
              updateModule({ moduleId: productModule.id, ...value })
            }
            onArchive={(archive) =>
              updateModule({
                moduleId: productModule.id,
                status: statusAfterArchive('module', archive),
              })
            }
            deleteWarning={
              issueCount > 0
                ? `${issueCount} issue${issueCount === 1 ? '' : 's'} name this module. They stay, and the module comes off each of them.`
                : 'The module goes, along with the repositories connected to it. No issue is deleted.'
            }
            onDelete={() =>
              deleteModule(
                { moduleId: productModule.id },
                {
                  onSuccess: () =>
                    router.push(workspaceHref(workspaceSlug, 'modules')),
                },
              )
            }
          />

          <Section
            title="Owner"
            description="A module belongs to one product or one team. Pick the one that would still be responsible if everything else changed."
          >
            <div className="flex items-center gap-2 px-4 py-3">
              <div className="flex-1">
                <OwnerSelect
                  value={{
                    ownerTeamId: productModule.ownerTeamId ?? null,
                    ownerProductId: productModule.ownerProductId ?? null,
                  }}
                  onChange={(next) =>
                    updateModule({ moduleId: productModule.id, ...next })
                  }
                />
              </div>
              <Badge variant="secondary">
                {productModule.ownerProductId ? 'Product' : 'Team'} ·{' '}
                {owner?.name ?? 'Nobody'}
              </Badge>
            </div>
          </Section>

          <Section
            title="Linked to"
            description="Teams and products that work with this module without owning it. Links connect the dots — they don't change who can see its issues."
          >
            <LinkPicker module={productModule} />
          </Section>

          <Section
            title="Repositories"
            description="Which repositories, or which paths inside them, hold this module's code. They come from the directories and source control accounts this workspace has added under Settings → Integrations."
          >
            <Repositories moduleId={productModule.id} />
          </Section>

          <Section
            title="Capabilities"
            description="What this module helps the software do. A capability usually needs code in more than one module, so the same one can appear on several of these pages."
          >
            <CapabilityPicker moduleId={productModule.id} />
          </Section>

          {/*
            One line, not a list. It says how much work touches this code and
            hands off to the place built for reading issues.

            The module goes with it as a query parameter. The list turns that
            into a visible filter, so the reader arrives at these issues and
            not at every issue in the workspace.
          */}
          <NextLink
            href={`${workspaceHref(workspaceSlug, 'all')}?module=${encodeURIComponent(
              productModule.id,
            )}`}
            className="flex items-center gap-2 text-muted-foreground hover:text-foreground"
          >
            <IssuesLine size={14} />
            {issueCount === 1
              ? '1 issue touches this module'
              : `${issueCount} issues touch this module`}
          </NextLink>
        </div>
      </MainLayout>
    );
  }),
);

ModuleView.getLayout = function getLayout(page: React.ReactElement) {
  return <AppLayout>{page}</AppLayout>;
};
