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
