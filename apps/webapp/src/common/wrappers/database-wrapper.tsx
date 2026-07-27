import { Loader } from '@vantikhq/ui/components/loader';
import * as React from 'react';

import { hash } from 'common/common-utils';

import { useCurrentWorkspace } from 'hooks/workspace';

import { initDatabase, reconcileSchemaVersion } from 'store/database';
import { initOutbox } from 'store/outbox';
import { UserContext } from 'store/user-context';

interface Props {
  children: React.ReactElement;
}

export function DatabaseWrapper(props: Props): React.ReactElement {
  const { children } = props;
  const workspace = useCurrentWorkspace();
  const user = React.useContext(UserContext);
  const [loading, setLoading] = React.useState(true);
  const hashKey = `${workspace.id}__${user.id}`;

  React.useEffect(() => {
    if (!workspace) {
      return;
    }

    const open = async () => {
      const workspaceHash = hash(hashKey);

      initDatabase(workspaceHash);

      // Opened alongside the cache but kept separate from it, so a resync that
      // drops and rebuilds the cache cannot take unsent writes with it.
      initOutbox(workspaceHash);

      // Has to finish before the children mount. BootstrapWrapper reads the
      // stored sequence id as it renders and picks a delta sync over a full
      // bootstrap on the strength of it, so a wipe that landed afterwards would
      // leave it syncing forward from data that no longer exists.
      try {
        await reconcileSchemaVersion(workspaceHash);
      } catch (error) {
        // Not fatal: Dexie will surface the same failure on first use, and a
        // loader stuck forever is worse than a degraded store.
        // eslint-disable-next-line no-console
        console.error('Failed to reconcile local database schema', error);
      }

      setLoading(false);
    };

    void open();

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  if (loading) {
    return <Loader text="Starting database..." />;
  }

  return <>{children}</>;
}
