/**
 * The contract between the server and the code that talks to a third party.
 *
 * One plugin per vendor, covering both halves of it. Today those halves are
 * split: an "integration" under `apps/server/src/integrations/<slug>` answers
 * connection questions and works, while an "action" under `actions/<name>`
 * reacts to events, is fetched over HTTP and evaluated with `new Function`, and
 * has never executed in this deployment. That split is not a design — it is the
 * residue of a migration that moved integrations out of the server in August
 * 2024 and brought only the latency-sensitive half back in September. See
 * ENG-89.
 *
 * These types live in the server because the server is the only thing that
 * loads a plugin. If plugins are ever authored outside this repository they
 * move to `@vantikhq/types` at that point, and not before.
 */

// The payloads crossing this boundary are vendor-shaped and cannot be usefully
// typed here; each plugin narrows what it receives.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export interface PluginLogger {
  debug(message: string, data?: Json): void;
  info(message: string, data?: Json): void;
  error(message: string, data?: Json): void;
}

/**
 * The connected account this plugin acts for.
 *
 * The only capability the existing integrations need today: every `PrismaClient`
 * in `apps/server/src/integrations/` exists to read or write an
 * `integrationAccount`, and nothing else.
 */
export interface AccountCapability {
  get(accountId: string): Promise<Json>;
  byDefinition(slug: string, workspaceId: string): Promise<Json | null>;
  /**
   * Find an account from the workspace *slug*.
   *
   * Inbound email is the reason: the address carries the workspace as text
   * (`…+acme-inbox@…`), so the only handle the plugin has at that point is a
   * slug. Kept separate from `byDefinition` rather than overloading it, because
   * one takes an id the host resolved and the other takes a string off a
   * message somebody sent us.
   */
  byWorkspaceSlug(slug: string, workspaceSlug: string): Promise<Json | null>;
  /**
   * The account a *person* connected, as opposed to the workspace installation.
   *
   * GitHub is why: a comment synced to a pull request is posted as the person
   * when they have linked their own account, and as the installation bot when
   * they have not — so who wrote it is visible on GitHub rather than everything
   * arriving from one robot.
   */
  personal(
    slug: string,
    workspaceId: string,
    userId: string,
  ): Promise<Json | null>;
  upsert(input: Json): Promise<Json>;
  update(accountId: string, data: Json): Promise<Json>;
}

export interface IssueCapability {
  get(issueId: string): Promise<Json>;
  getByNumber(teamId: string, number: number): Promise<Json>;
  create(teamId: string, input: Json): Promise<Json>;
  update(issueId: string, teamId: string, input: Json): Promise<Json>;
}

export interface CommentCapability {
  get(commentId: string): Promise<Json>;
  replies(commentId: string): Promise<Json>;
  create(input: Json): Promise<Json>;
  update(commentId: string, input: Json): Promise<Json>;
}

/**
 * The mapping between a Vantik issue and the thing it mirrors elsewhere.
 *
 * The largest group in the measured surface, and the reason these plugins are
 * two-way sync rather than notifiers. `bySource` is the inbound direction: a
 * webhook arrives naming a channel or a pull request, and this turns that into
 * an issue we already know about.
 */
export interface LinkCapability {
  get(linkId: string): Promise<Json>;
  bySource(sourceId: string): Promise<Json>;
  forIssue(issueId: string): Promise<Json>;
  create(input: Json, userId?: string): Promise<Json>;
  update(linkId: string, input: Json): Promise<Json>;
  updateBySource(sourceId: string, input: Json): Promise<Json>;
  comment(sourceId: string): Promise<Json>;
  createComment(input: Json): Promise<Json>;
}

/** Read-only workspace metadata a plugin reads to place its work. */
export interface WorkspaceCapability {
  teams(): Promise<Json>;
  team(teamId: string): Promise<Json>;
  teamByName(name: string): Promise<Json>;
  users(): Promise<Json>;
  labels(): Promise<Json>;
  workflows(teamId: string): Promise<Json>;
}

/** The deployment's LLM, for the plugins that summarise or enrich. */
export interface AiCapability {
  request(input: Json): Promise<Json>;
}

/**
 * Reaching the vendor, without holding the vendor's credential.
 *
 * `path` is resolved against the plugin's `baseUrl`; the host attaches the
 * credential for this account and refuses any host outside `egress`. So a
 * plugin says *what* to call and never learns the token — the same control
 * ENG-60 chose for git tokens, where the decisive property was that the
 * credential never enters the guest.
 *
 * The cost, stated rather than discovered: a plugin cannot be handed a vendor
 * SDK, because a constructed client carries the credential inside it. Of the
 * six vendors here that affects one — `discord.js`, for two calls that are one
 * REST request each.
 */
export interface VendorCapability {
  /**
   * `target` is a path relative to `baseUrl`, or an absolute URL.
   *
   * Absolute is allowed because a vendor hands them back: GitHub stores a
   * comment's `url` on the linked comment, and replying means posting to the
   * URL it gave us rather than a path we compose. That is not a hole — the
   * egress check runs on the resolved host either way, so a `sourceData` that
   * has been tampered with is refused rather than followed.
   *
   * `as` names *which identity* to act as, never a credential. GitHub needs
   * this: a comment is posted as the person when they have connected their own
   * account, and as the installation bot when they have not. The plugin says
   * which; `spec.auth` decides what that means and the plugin still never sees
   * a token.
   */
  fetch(
    target: string,
    init?: RequestInit & { as?: string },
  ): Promise<Response>;
}

/**
 * What a plugin declares about itself.
 *
 * Static, because the host reads it before deciding whether a call is allowed.
 * A capability that depends on the plugin's own restraint is not a capability,
 * so the allowlist is declared here and applied by the host.
 */
export interface PluginSpec {
  slug: string;
  baseUrl?: string;
  /** Exact hostnames. No wildcards — a wildcard is how an allowlist stops being one. */
  egress: string[];
  /**
   * How the host builds the Authorization header.
   *
   * `as` is the identity the plugin asked for, when it asked for one.
   */
  auth?: (account: Json, as?: string) => string | undefined;
}

/**
 * The plugin's own `IntegrationDefinitionV2` row.
 *
 * A plugin needs this when it creates the first account for a workspace and has
 * to name the definition it belongs to. `local-repo` is the case: it makes an
 * account per workspace the first time a repository is registered.
 */
export interface DefinitionCapability {
  get(slug: string): Promise<Json>;
}

/**
 * What a plugin is asked to do.
 *
 * Every member is plain data. Nothing is a live object, a client or a
 * connection, so the same event can be passed to a function, written to a
 * queue, or sent across a process boundary unchanged. That is what makes where
 * a plugin runs a deployment choice rather than a rewrite.
 */
export interface PluginEvent {
  /** `ActionTypesEnum` or `IntegrationPayloadEventType`, depending on the half. */
  event: string;
  [key: string]: Json;
}

/**
 * What a plugin is allowed to do, and the only way it can do anything.
 *
 * A plugin asks the host to do a thing rather than being handed the means to do
 * it itself. That is what lets the host decide where the plugin runs; code
 * holding its own `PrismaClient`, as every integration does today, has defeated
 * the idea whether or not a wrapper exists.
 */
export interface PluginContext {
  readonly workspaceId?: string;
  readonly log: PluginLogger;
  readonly account: AccountCapability;
  readonly issues: IssueCapability;
  readonly comments: CommentCapability;
  readonly links: LinkCapability;
  readonly workspace: WorkspaceCapability;
  readonly ai: AiCapability;
  readonly definitions: DefinitionCapability;
  readonly vendor: VendorCapability;
}

/**
 * A plugin's entry point.
 *
 * Second argument, not first, so that every integration written against the
 * old single-argument signature keeps working while the vendors are ported one
 * at a time.
 */
export type PluginHandler = (
  event: PluginEvent,
  ctx: PluginContext,
) => Promise<Json>;
