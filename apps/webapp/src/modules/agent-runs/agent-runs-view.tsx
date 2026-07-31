/* eslint-disable @typescript-eslint/no-explicit-any */
import { observer } from 'mobx-react-lite';
import React from 'react';

import { MainLayout } from 'common/layouts/main-layout';
import { SCOPES } from 'common/scopes';
import { withApplicationStore } from 'common/wrappers/with-application-store';

import { useScope } from 'hooks';

import { useContextStore } from 'store/global-context-provider';

import { Header } from './header';
import { GroupedRuns } from './runs-list/grouped-runs';

/**
 * Every agent run in the workspace, grouped by the issue it was working on.
 *
 * The point of background work is that nobody is watching any single issue, so
 * there has to be one place answering "what has been happening" without
 * opening issues one at a time.
 *
 * This was the flat table the products and teams lists share, and as a flat
 * table it was mostly one issue's name repeated: seven consecutive rows for one
 * issue, each clipping the same title, and the duplicated column was the widest
 * one — so it pushed the durations off the right edge. Work happens per issue,
 * several attempts at a time, so the list is grouped the way the data already
 * is. That means drawing the list here instead of through `RecordTable`, which
 * has no notion of a group heading.
 *
 * A row opens the run; the heading opens the issue. A list beside a permanent
 * detail pane would have put a second navigation rail against the app's own,
 * which is two lists competing for the same edge of the screen; a run is a page.
 */
export const AgentRunsView = withApplicationStore(
  observer(() => {
    useScope(SCOPES.AllIssues);

    const { agentRunsStore } = useContextStore();

    // Copied out of the MST array, which is not a plain array — the same reason
    // the products list does it.
    const runs: any[] = [...agentRunsStore.byRecency];

    return (
      <MainLayout scrollable header={<Header crumbs={[{ title: 'Agents' }]} />}>
        <GroupedRuns runs={runs} />
      </MainLayout>
    );
  }),
);
