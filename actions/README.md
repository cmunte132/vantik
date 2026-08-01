# actions/ — being retired

These are the un-ported half of the vendors.

An "action" and an "integration" were two halves of the same vendor, split by a
latency fix in September 2024 rather than by a design: integrations moved out of
the server to trigger.dev in August 2024, and only the half a person waits on
during OAuth came back. See ENG-89.

trigger.dev is gone from this repository, so **nothing here runs**. That is not
a regression — none of it has ever executed in this deployment, the registry in
`actions.json` is empty, and no package here has a `build` script for
`vantik deploy` to call.

Each directory moves into `apps/server/src/integrations/<slug>` as one plugin
with a `pluginSpec` and a handler, at which point its behaviour executes again
for the first time. `discord` and `bug-enricher` have moved and are deleted from
here.

Remaining: `email`, `github`, `issue-view-summary`, `whatsapp`.

Two things a port has to do beyond moving the file:

- **Drop the vendor SDK and the credential.** A plugin calls `ctx.vendor.fetch`
  and the host attaches the token, so the plugin never holds one.
- **Replace `@vantikhq/sdk` calls with capabilities.** The SDK carried the
  caller's Vantik access token, which gave a plugin the whole API; a capability
  gives it the operation it asked for.
