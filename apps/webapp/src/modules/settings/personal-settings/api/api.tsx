import * as React from 'react';

import { SettingSection } from 'modules/settings/setting-section';

import { LocalSetup } from './agents/local-setup';
import { TokenList } from './tokens/token-list';

/**
 * The credentials you mint for yourself.
 *
 * One section for tokens, because there is one kind of credential. What used to
 * be "personal access tokens" and "agent accounts" are rows in the same table,
 * minted by the same generator and resolved by the same code; the only thing
 * that differs is whose identity the token carries when it calls. Neither is
 * tied to a transport — an agent token authenticates a plain REST call exactly
 * as a personal one does — so the config below is how you point *any* token at
 * this workspace, not a property of agents.
 *
 * The page holds the token that was just minted, and that is the point of it
 * living up here. A token exists in exactly one HTTP response and can never be
 * fetched again, so the create form used to render the whole setup guide with
 * the real value in it — leaving the page showing two copies of the same harness
 * tabs, config blocks and skill install, one live and one with a placeholder,
 * with nothing to say which was which. Holding the value at the page instead
 * lets the one set of instructions be the live one while it is on screen.
 */
export function API() {
  const [newToken, setNewToken] = React.useState<string | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-xl"> API &amp; Agents </h2>

      <SettingSection
        title="Access tokens"
        description="Credentials you mint for yourself. A token either acts as you, carrying your account and permissions, or as its own identity — an agent, whose edits are attributed to it and whose permissions you grant."
      >
        <TokenList newToken={newToken} onNewToken={setNewToken} />
      </SettingSection>

      <SettingSection
        title="Connecting a client"
        description={
          newToken
            ? 'Filled in with the token you just created. Copy what you need now — dismissing it above puts the placeholder back, and the token cannot be shown again.'
            : 'How to point a harness or MCP client on your machine at this workspace. The config is the same for any token — only the value differs, and you get that when you create one above.'
        }
      >
        <LocalSetup token={newToken ?? undefined} />
      </SettingSection>
    </div>
  );
}
