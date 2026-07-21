import { Loader } from '@vantikhq/ui/components/loader';
import * as React from 'react';

import { hash } from 'common/common-utils';

import { useCurrentWorkspace } from 'hooks/workspace';

import { initDatabase } from 'store/database';
import { UserContext } from 'store/user-context';

// Baked in at build time on purpose: the version identifies the bundle the
// browser is running, so it must not follow the container's environment.
const APP_VERSION = process.env.NEXT_PUBLIC_VERSION;

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
    if (workspace) {
      const version = localStorage.getItem('version');
      if (version !== APP_VERSION) {
        localStorage.setItem('version', APP_VERSION);
      }

      initDatabase(hash(hashKey));
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  if (loading) {
    return <Loader text="Starting database..." />;
  }

  return <>{children}</>;
}
