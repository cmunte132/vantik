import * as React from 'react';

import {
  getLoadedClientConfig,
  loadClientConfig,
} from 'common/lib/client-config';

/**
 * Whether this install has an LLM endpoint configured.
 *
 * The AI affordances are left out of the interface entirely when it does not,
 * rather than shown and then failing on press. Starts false and turns true once
 * the config lands, so nothing appears and then disappears — the config fetch
 * is already in flight before the app renders, so in practice it is resolved by
 * the first paint.
 */
export function useAIEnabled(): boolean {
  const [enabled, setEnabled] = React.useState(
    () => getLoadedClientConfig()?.aiEnabled ?? false,
  );

  React.useEffect(() => {
    let active = true;

    void loadClientConfig().then((config) => {
      if (active) {
        setEnabled(config.aiEnabled);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  return enabled;
}
