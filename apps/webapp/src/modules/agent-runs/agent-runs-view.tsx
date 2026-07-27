/* eslint-disable @typescript-eslint/no-explicit-any */
import { observer } from 'mobx-react-lite';
import { useRouter } from 'next/router';
import React from 'react';

import { MainLayout } from 'common/layouts/main-layout';
import { SCOPES } from 'common/scopes';
import { workspaceHref } from 'common/workspace-href';
import { withApplicationStore } from 'common/wrappers/with-application-store';

import { RecordTable } from 'components/record-table';
import { useScope } from 'hooks';

import { useContextStore } from 'store/global-context-provider';

import { Header } from './header';
import { useRunColumns } from './runs-list/columns';

/**
 * Every agent run in the workspace, one row each.
 *
 * The point of background work is that nobody is watching any single issue, so
 * there has to be one place answering "what has been happening" without
 * opening issues one at a time.
 *
 * The same table the products and teams lists use, and a row opens the run the
 * way a product row opens the product. A list beside a permanent detail pane
 * would have put a second navigation rail against the app's own, which is two
 * lists competing for the same edge of the screen; a run is a page.
 */
export const AgentRunsView = withApplicationStore(
  observer(() => {
    useScope(SCOPES.AllIssues);

    const { agentRunsStore } = useContextStore();
    const router = useRouter();
    const { workspaceSlug } = router.query;

    // react-table keeps `data` by reference and reads it as a plain array. An
    // MST array is neither, so it has to be copied out — the same reason the
    // products list does.
    const runs: any[] = [...agentRunsStore.byRecency];
    const columns = useRunColumns();

    return (
      <MainLayout scrollable header={<Header crumbs={[{ title: 'Agents' }]} />}>
        <RecordTable
          data={runs}
          columns={columns}
          onRowClick={(run: any) =>
            router.push(workspaceHref(workspaceSlug, 'agent-runs', run.id))
          }
          empty="No agent runs yet. Open an issue and delegate it to an agent."
        />
      </MainLayout>
    );
  }),
);
