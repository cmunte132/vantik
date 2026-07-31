import * as React from 'react';

import { AppLayout } from 'common/layouts/app-layout';

import { AgentRunsView } from './agent-runs-view';
import { RunView } from './run-view';

/** The workspace's agent runs. */
export const AgentRuns = AgentRunsView;

AgentRuns.getLayout = function getLayout(page: React.ReactElement) {
  return <AppLayout>{page}</AppLayout>;
};

/** One run. */
export const AgentRun = RunView;

AgentRun.getLayout = function getLayout(page: React.ReactElement) {
  return <AppLayout>{page}</AppLayout>;
};

export * from './agent-runs-view';
export * from './run-view';
