/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@vantikhq/ui/components/dialog';

import { RunActivity } from 'modules/agent-runs/run-activity';
import { toFeed } from 'modules/agent-runs/run-feed';

import { useSessionEvents, useSessionUsage } from 'services/agent-sessions';

import { type SessionUsage } from './session-usage';
import { SessionUsageSummary } from './session-usage-summary';
import {
  harnessLabel,
  sessionTitle,
  terminalActivity,
} from './session-vocabulary';

interface Props {
  session: any;
  open: boolean;
  setOpen: (value: boolean) => void;
}

/**
 * What happened in a session that has no run, which is what a person did in
 * their own terminal. It draws the same feed as a run's page, from the steps
 * the connector read out of the omp session file.
 */
export const SessionActivityDialog = ({ session, open, setOpen }: Props) => {
  const { data, isPending, isError } = useSessionEvents(session.id, open);
  // Read only while the view is open, one session at a time.
  const usage = useSessionUsage(session.id, open);
  const events: any[] = Array.isArray(data) ? data : [];
  const feed = toFeed(events);
  const first = events[0]?.at ? Date.parse(events[0].at) : Date.now();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{sessionTitle(session)}: activity</DialogTitle>
        </DialogHeader>

        <SessionUsageSummary
          usage={usage.data as SessionUsage | undefined}
          isPending={usage.isPending}
          isError={usage.isError}
        />

        {isPending ? (
          <p className="py-4 text-muted-foreground">Loading.</p>
        ) : isError ? (
          <p className="py-4 text-muted-foreground">
            Could not load this session.
          </p>
        ) : (
          <RunActivity
            feed={feed}
            start={first}
            current={null}
            live={false}
            harness={harnessLabel(session?.harness)}
            terminal={terminalActivity(session) ?? undefined}
          />
        )}
      </DialogContent>
    </Dialog>
  );
};
