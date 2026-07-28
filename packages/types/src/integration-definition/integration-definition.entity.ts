import { IntegrationAccount } from '../integration-account';
import { Workspace } from '../workspace';

export class OAuth2Params {
  authorization_url: string;
  authorization_params?: Record<string, string>;
  default_scopes?: string[];
  scope_separator?: string;
  token_url: string;
  token_params?: Record<string, string>;
  redirect_uri_metadata?: string[];
  token_response_metadata?: string[];
  token_expiration_buffer?: number; // In seconds.
  scopes?: string[];
}

/**
 * The declaration of an integration that needs no third party.
 *
 * The server holds everything that this integration type needs. There is no
 * account to authorise, so the settings page shows a form and not a Connect
 * button.
 */
export class LocalParams {
  /** The sentence that the settings page shows above the form. */
  instruction: string;
}

export class Spec {
  /**
   * The OAuth2 flow for the whole workspace. An integration that declares
   * `local_auth` has no such flow, so this field is optional.
   */
  workspace_auth?: {
    OAuth2: OAuth2Params;
  };
  personal_auth?: {
    OAuth2: OAuth2Params;
  };
  local_auth?: LocalParams;
  other_data?: any;
}

export class IntegrationDefinition {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  deleted: Date | null;
  name: string;
  slug: string;
  description: string;
  icon: string;
  config?: any;
  spec?: Spec;
  clientId: string;
  clientSecret: string;
  /**
   * This field says that the deployment has the credentials of this
   * integration. Only a response to the browser carries it, and that response
   * carries neither the client secret nor the config.
   */
  configured?: boolean;
  /**
   * The two environment variables that hold the credentials of this
   * integration. The settings page names them when the deployment has none.
   */
  credentialEnv?: { clientId: string; clientSecret: string };
  workspace?: Workspace;
  workspaceId?: string;
  IntegrationAccount?: IntegrationAccount[];
}

export class PublicIntegrationDefinition {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  deleted: Date | null;
  name: string;
  slug: string;
  description: string;
  icon: string;
  config?: any;
  spec?: Spec;
  workspace?: Workspace;
  workspaceId?: string;
  IntegrationAccount?: IntegrationAccount[];
}
