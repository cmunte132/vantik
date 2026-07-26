/** Copyright (c) 2024, Vantik, all rights reserved. **/

'use client';

import { useIsMutating } from '@tanstack/react-query';
import * as React from 'react';

import {
  BUILD_HEADER,
  BUILD_ID,
  VERSION_TRACKING_ENABLED,
  fetchServedVersion,
  isDifferentBuild,
} from 'common/lib/app-version';
import {
  reloadBlockedReason,
  reloadIntoLatestBuild,
  restoreScrollAfterReload,
  startInteractionTracking,
  stopInteractionTracking,
} from 'common/lib/reload-guard';
import { installStaleChunkRecovery } from 'common/lib/stale-chunk-recovery';

import { offError, offSuccess, onError, onSuccess } from 'services/utils/ajax';

/**
 * Backstop cadence, not the primary signal. The socket announcement and the
 * response header both react in seconds; this only has to cover the cases they
 * cannot — socket down, or a window that was asleep.
 */
const POLL_INTERVAL_MS = 15 * 60 * 1000;

/** How often to re-test whether a pending reload can now happen silently. */
const SAFETY_RECHECK_MS = 15 * 1000;

/**
 * An update that has been waiting this long has failed to find a quiet moment,
 * so the notice becomes harder to miss. It stays dismissible — nothing here
 * ever blocks the app.
 */
const ESCALATE_AFTER_MS = 30 * 60 * 1000;

interface AppVersionValue {
  /** A different build is being served than the one running. */
  updateAvailable: boolean;
  /** Long enough that the nudge should be more visible. */
  overdue: boolean;
  /** The build the server is serving, once known. */
  servedBuildId?: string;
  /** Why a silent reload has not happened yet, for the debug surface. */
  blockedReason?: string;
  reloadNow: () => void;
  dismiss: () => void;
}

const AppVersionContext = React.createContext<AppVersionValue>({
  updateAvailable: false,
  overdue: false,
  reloadNow: () => undefined,
  dismiss: () => undefined,
});

export function useAppVersion() {
  return React.useContext(AppVersionContext);
}

/**
 * A version announcement from somewhere other than this provider.
 *
 * The socket gateway is the fastest way to learn that a deploy happened, but it
 * announces the *server* image's stamp, and the client compares itself against
 * the *webapp* build. Since the two images are stamped together by a deploy,
 * a changed server stamp is a reliable prompt to go and ask /api/version, which
 * is authoritative. Treating it as a prompt rather than an answer is what keeps
 * a server-only restart from claiming the webapp changed.
 */
let announceDeploy: (() => void) | undefined;

export function noteServerDeployAnnouncement() {
  announceDeploy?.();
}

interface Props {
  children: React.ReactNode;
}

export function AppVersionProvider({ children }: Props) {
  const [servedBuildId, setServedBuildId] = React.useState<string>();
  const [detectedAt, setDetectedAt] = React.useState<number>();
  const [escalatedAt, setEscalatedAt] = React.useState<number>();
  const [dismissedAt, setDismissedAt] = React.useState<number>();
  const [blockedReason, setBlockedReason] = React.useState<string>();

  const pendingMutations = useIsMutating();

  const updateAvailable = isDifferentBuild(servedBuildId);

  // Chunk recovery is gated the same way detection is. In development a failed
  // dynamic import is routinely just Fast Refresh mid-recompile, not a build
  // that was replaced, and reloading on it throws away whatever the developer
  // was in the middle of. Worse, the attempt guard is keyed on BUILD_ID, which
  // is the fixed string 'dev' there — so that one spurious reload also spends
  // the only attempt and leaves recovery dead for the rest of the session.
  //
  // Scroll restoration stays unconditional: with nothing stored it does
  // nothing, and it costs a single sessionStorage read to find that out.
  React.useEffect(() => {
    if (VERSION_TRACKING_ENABLED) {
      installStaleChunkRecovery();
    }

    restoreScrollAfterReload();
  }, []);

  /**
   * Confirms against the authority. Every other path funnels through here, so a
   * mismatched header or a socket announcement can never on its own put a notice
   * in front of the user.
   */
  const confirmServedVersion = React.useCallback(async () => {
    const served = await fetchServedVersion();

    if (!served) {
      return;
    }

    setServedBuildId(served.buildId);

    if (isDifferentBuild(served.buildId)) {
      setDetectedAt((current) => current ?? Date.now());
    } else {
      // The server went back to serving this build — a rollback, or a header we
      // read wrong. Either way there is nothing to tell anyone about.
      setDetectedAt(undefined);
      setEscalatedAt(undefined);
      setDismissedAt(undefined);
    }
  }, []);

  // Detection: response headers, socket announcements, focus, reconnect, poll.
  React.useEffect(() => {
    if (!VERSION_TRACKING_ENABLED) {
      return undefined;
    }

    startInteractionTracking();

    let disposed = false;

    const check = () => {
      if (!disposed) {
        void confirmServedVersion();
      }
    };

    // Rides on traffic the app already makes; costs nothing until it disagrees.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const readHeaders = (_payload: any, _config: any, headers: any) => {
      const served = headers?.[BUILD_HEADER];

      if (isDifferentBuild(served) && served !== servedBuildId) {
        check();
      }
    };

    onSuccess(readHeaders);
    onError(readHeaders);

    announceDeploy = check;

    const onVisible = () => {
      if (!document.hidden) {
        check();
      }
    };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', check);

    const interval = window.setInterval(check, POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      offSuccess(readHeaders);
      offError(readHeaders);
      announceDeploy = undefined;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', check);
      window.clearInterval(interval);
      stopInteractionTracking();
    };
  }, [confirmServedVersion, servedBuildId]);

  // Reaction: reload the moment it is safe to do so unnoticed.
  React.useEffect(() => {
    if (!updateAvailable) {
      setBlockedReason(undefined);
      return undefined;
    }

    const attempt = () => {
      const reason = reloadBlockedReason({ pendingMutations });

      setBlockedReason(reason);

      if (!reason) {
        reloadIntoLatestBuild();
        return;
      }

      if (detectedAt && Date.now() - detectedAt > ESCALATE_AFTER_MS) {
        setEscalatedAt((current) => current ?? Date.now());
      }
    };

    // Immediately, then on a timer and whenever the window is put down: a chip
    // raised while the user was typing still resolves itself silently once they
    // stop, which is the case that makes this worth having.
    attempt();

    const interval = window.setInterval(attempt, SAFETY_RECHECK_MS);
    document.addEventListener('visibilitychange', attempt);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', attempt);
    };
  }, [updateAvailable, pendingMutations, detectedAt]);

  const value = React.useMemo<AppVersionValue>(
    () => ({
      // A dismissed notice re-surfaces once, when it escalates. Dismissal
      // silences the nudge; it never stops the silent reload, which the user
      // does not need to consent to because they cannot tell it happened.
      updateAvailable:
        updateAvailable &&
        (!dismissedAt || (!!escalatedAt && dismissedAt < escalatedAt)),
      overdue: !!escalatedAt,
      servedBuildId,
      blockedReason,
      reloadNow: reloadIntoLatestBuild,
      dismiss: () => setDismissedAt(Date.now()),
    }),
    [updateAvailable, dismissedAt, escalatedAt, servedBuildId, blockedReason],
  );

  if (typeof window !== 'undefined') {
    // Cheap handle for support questions: "which build is this window running?"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__vantikBuild = BUILD_ID;
  }

  return (
    <AppVersionContext.Provider value={value}>
      {children}
    </AppVersionContext.Provider>
  );
}
