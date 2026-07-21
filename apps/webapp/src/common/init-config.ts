import posthog from 'posthog-js';
import SuperTokensReact from 'supertokens-auth-react';

import { loadClientConfig } from 'common/lib/client-config';
import { frontendConfig } from 'common/lib/config';

export function initSuperTokens() {
  // we only want to call this init function on the frontend, so we check typeof window !== 'undefined'
  if (typeof window !== 'undefined') {
    // Stays synchronous: frontendConfig() derives everything it needs from the
    // page origin, so it does not wait on the runtime config fetch.
    SuperTokensReact.init(frontendConfig());
  }
}

export async function initPosthog() {
  if (typeof window === 'undefined') {
    return;
  }

  const { posthogKey, posthogHost } = await loadClientConfig();

  // No key means analytics are switched off for this install, which is the
  // default for self-hosted.
  if (!posthogKey) {
    return;
  }

  posthog.init(posthogKey, {
    api_host: posthogHost,
    person_profiles: 'identified_only', // or 'always' to create profiles for anonymous users as well
    loaded: (posthog) => {
      if (process.env.NODE_ENV === 'development') {
        posthog.debug();
      } // debug mode in development
    },
  });
}
