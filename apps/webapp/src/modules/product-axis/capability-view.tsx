import { RiInboxLine } from '@remixicon/react';
import { Badge } from '@vantikhq/ui/components/badge';
import { Button } from '@vantikhq/ui/components/button';
import { Input } from '@vantikhq/ui/components/input';
import { observer } from 'mobx-react-lite';
import NextLink from 'next/link';
import { useRouter } from 'next/router';
import React from 'react';

import { ModuleDropdown } from 'modules/issues/components/issue-metadata/product-axis';

import { AppLayout } from 'common/layouts/app-layout';
import { MainLayout } from 'common/layouts/main-layout';
import { SCOPES } from 'common/scopes';
import { workspaceHref } from 'common/workspace-href';
import { withApplicationStore } from 'common/wrappers/with-application-store';

import { useScope } from 'hooks';
import { useCapability } from 'hooks/product-axis';

import { useUpdateCapabilityMutation } from 'services/product-axis';

import { useContextStore } from 'store/global-context-provider';

import { isArchived, statusAfterArchive } from './archive';
import { Header } from './header';
import { ScopedIssues } from './scoped-issues';

/**
 * One capability: the modules that hold its code, and its issues.
 *
 * A capability names its modules and never a product. One capability usually
 * needs code in more than one module, so the product is read back from the
 * owners of those modules rather than stored here.
 */
export const CapabilityView = withApplicationStore(
  observer(() => {
    useScope(SCOPES.AllIssues);

    const capability = useCapability();
    const { modulesStore } = useContextStore();
    const { mutate: updateCapability } = useUpdateCapabilityMutation({});
    const {
      query: { workspaceSlug },
    } = useRouter();

    if (!capability) {
      return <h2>No capability found</h2>;
    }

    const modules = capability.moduleIds
      .map((id: string) => modulesStore.getModuleWithId(id))
      .filter(Boolean);

    return (
      <MainLayout
        header={
          <Header
            crumbs={[
              {
                title: 'Capabilities',
                href: workspaceHref(workspaceSlug, 'capabilities'),
              },
              { title: capability.name },
            ]}
          />
        }
      >
        <div className="flex flex-col h-[calc(100vh_-_55px)]">
          {/*
            A capability has no icon and no owner to set, so it needs no
            identity card. What it does need is the two things every row on this
            axis has: a name a person can change, and a way to stop the work.
          */}
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <CapabilityName
              name={capability.name}
              onRename={(name) =>
                updateCapability({ capabilityId: capability.id, name })
              }
            />

            <Button
              variant="ghost"
              size="sm"
              className="gap-1 text-muted-foreground shrink-0"
              onClick={() =>
                updateCapability({
                  capabilityId: capability.id,
                  status: statusAfterArchive(
                    'capability',
                    !isArchived(capability),
                  ),
                })
              }
            >
              <RiInboxLine size={14} />
              {isArchived(capability) ? 'Restore' : 'Archive'}
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <Badge variant="outline">{capability.status ?? 'planned'}</Badge>

            {modules.length === 0 ? (
              <span className="text-muted-foreground">
                Nobody has built this yet.
              </span>
            ) : (
              <>
                <span className="text-muted-foreground">Lives in</span>
                {modules.map((module) => (
                  <NextLink
                    key={module.id}
                    href={workspaceHref(workspaceSlug, 'module', module.key)}
                  >
                    <Badge variant="secondary">{module.name}</Badge>
                  </NextLink>
                ))}
              </>
            )}

            {/*
              The modules are edited here, on the capability itself. This list is
              what gives a capability its identity, and it is also what puts the
              capability under a product: the product is read back from the
              owners of these modules, and is never stored.
            */}
            <div className="ml-auto">
              <ModuleDropdown
                value={capability.moduleIds}
                onChange={(moduleIds) =>
                  updateCapability({ capabilityId: capability.id, moduleIds })
                }
              />
            </div>
          </div>

          <ScopedIssues capabilityId={capability.id} />
        </div>
      </MainLayout>
    );
  }),
);

CapabilityView.getLayout = function getLayout(page: React.ReactElement) {
  return <AppLayout>{page}</AppLayout>;
};

/**
 * The name of a capability, which a person edits in place.
 *
 * The draft follows the name, because somebody else can rename the capability
 * while this page is open. A draft that ignored that would put the old name
 * back on the next keystroke.
 */
function CapabilityName({
  name,
  onRename,
}: {
  name: string;
  onRename: (name: string) => void;
}) {
  const [draft, setDraft] = React.useState(name);

  React.useEffect(() => setDraft(name), [name]);

  const commit = () => {
    const next = draft.trim();

    if (next && next !== name) {
      onRename(next);
    } else {
      setDraft(name);
    }
  };

  return (
    <Input
      value={draft}
      aria-label="Capability name"
      className="text-base font-medium"
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commit();
          event.currentTarget.blur();
        }

        if (event.key === 'Escape') {
          setDraft(name);
          event.currentTarget.blur();
        }
      }}
    />
  );
}
