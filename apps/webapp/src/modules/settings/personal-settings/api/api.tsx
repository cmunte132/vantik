import { SettingSection } from 'modules/settings/setting-section';

import { LocalSetup } from './agents/local-setup';
import { TokenList } from './tokens/token-list';

/**
 * The credentials you mint for yourself.
 *
 * One section, because there is one kind of credential. What used to be
 * "personal access tokens" and "agent accounts" are rows in the same table,
 * minted by the same generator and resolved by the same code; the only thing
 * that differs is whose identity the token carries when it calls. Neither is
 * tied to a transport — an agent token authenticates a plain REST call exactly
 * as a personal one does — so the config below is how you point *any* token at
 * this workspace, not a property of agents.
 */
export function API() {
  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-xl"> API &amp; Agents </h2>

      <SettingSection
        title="Access tokens"
        description="Credentials you mint for yourself. A token either acts as you, carrying your account and permissions, or as its own identity — an agent, whose edits are attributed to it and whose permissions you grant."
      >
        <TokenList />
      </SettingSection>

      <SettingSection
        title="Connecting a client"
        description="How to point a harness or MCP client on your machine at this workspace. The config is the same for any token — only the value differs, and you get that when you create one above."
      >
        <LocalSetup />
      </SettingSection>
    </div>
  );
}
