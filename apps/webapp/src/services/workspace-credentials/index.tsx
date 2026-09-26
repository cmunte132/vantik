import { useQuery } from '@tanstack/react-query';

import { ajaxDelete, ajaxGet, ajaxPost, mutationHook } from 'services/utils';

/** The two secrets a workspace holds for hosted execution. */
export type CredentialKind = 'MODEL_API_KEY' | 'GIT_TOKEN';

/**
 * What the API is willing to say about a stored secret.
 *
 * Deliberately not the secret. The server has no endpoint that reads one back —
 * a "show it to me so I can check" route is how a credential store becomes a
 * credential leak — so `hint` is the whole of what this screen can display, and
 * every control here is written on the assumption that it never sees more.
 */
export interface CredentialHandle {
  kind: CredentialKind;
  /** Which provider a model key belongs to. Empty for the git token. */
  provider: string;
  /** `…a1b2`, or `…` when the secret was too short to hint at safely. */
  hint: string;
  baseUrl: string | null;
  updatedAt: string;
  rotatedAt: string | null;
  /**
   * What the provider said this key can reach, from the check made when it was
   * stored. Absent when the provider publishes no list or could not be
   * reached — which is a different thing from a key that reaches nothing.
   */
  models?: CatalogueModel[] | null;
  modelsCheckedAt?: string | null;
}

export interface CatalogueModel {
  id: string;
  label: string;
}

/** A provider this deployment knows how to run, as the server describes it. */
export interface ProviderOption {
  id: string;
  label: string;
  placeholder: string;
  baseUrl: { required: boolean; placeholder: string } | null;
  discoversModels: boolean;
}

const CREDENTIALS_KEY = 'workspace-credentials';
const PROVIDERS_KEY = 'model-providers';

/**
 * The providers this deployment can actually run.
 *
 * Served rather than listed in the client so the screen offers exactly what
 * the executor supports. A provider the server does not know is one whose key
 * would reach the harness under no name at all.
 */
export function useModelProviders(enabled: boolean = true) {
  return useQuery<ProviderOption[]>({
    queryKey: [PROVIDERS_KEY],
    queryFn: () => ajaxGet({ url: '/api/v1/workspace_credentials/providers' }),
    enabled,
    // A deployment's provider table changes when it is upgraded, not while
    // somebody is looking at a settings page.
    staleTime: Infinity,
  });
}

/**
 * The credentials this workspace holds, as masked handles.
 *
 * Admin-only server-side, so this is asked only when the caller is one —
 * requesting as anybody else earns a 403 and an error state saying nothing
 * useful.
 */
export function useWorkspaceCredentials(enabled: boolean = true) {
  return useQuery<CredentialHandle[]>({
    queryKey: [CREDENTIALS_KEY],
    queryFn: () => ajaxGet({ url: '/api/v1/workspace_credentials' }),
    enabled,
  });
}

// Whether this workspace can run agents is `useWorkspaceCredentials` holding a
// MODEL_API_KEY handle, and nothing else. An agent run only ever uses a key
// somebody here configured — it never borrows what drives Vantik's own AI
// features — so there is no second source to ask about.

const PREFERENCES_KEY = 'workspace-agent-preferences';

interface WorkspaceRecord {
  id: string;
  preferences?: Record<string, unknown> | null;
}

/**
 * The workspace's own record, for the parts of `preferences` the sync store
 * cannot carry.
 *
 * `preferences` is `types.model({})` in the MobX workspace model, so anything
 * inside it — including the whole `agentRuns` blob this screen edits — is
 * stripped on the way through. Rather than widen the synced model, which has
 * to be registered in half a dozen places and needs a Dexie bump to reach
 * clients that already exist, this reads the record straight from the API. It
 * is a settings screen: one fetch when it opens is the right price.
 *
 * `GET /v1/workspaces` returns every workspace the session can see rather than
 * the current one, so the row is picked out here.
 */
export function useWorkspaceRecord(workspaceId?: string) {
  return useQuery<WorkspaceRecord[], unknown, WorkspaceRecord | undefined>({
    queryKey: [PREFERENCES_KEY],
    queryFn: () => ajaxGet({ url: '/api/v1/workspaces' }),
    enabled: Boolean(workspaceId),
    select: (workspaces) =>
      (workspaces ?? []).find((entry) => entry.id === workspaceId),
  });
}

/** So a preferences write is reflected without a reload. */
export function workspaceRecordKey(): string {
  return PREFERENCES_KEY;
}

interface PutParams {
  kind: CredentialKind;
  provider?: string;
  secret: string;
  baseUrl?: string;
}

/** What the server says back: the handle, and why it could not check the key. */
export interface PutResult extends CredentialHandle {
  note?: string;
}

/**
 * Stores or rotates a secret, after the provider has been asked about it.
 *
 * A model key the provider refuses fails here rather than being stored, so an
 * error from this mutation is usually worth showing verbatim — it is the
 * provider's own verdict on the key that was just pasted.
 *
 * One credential per provider per workspace, so this is an upsert rather than
 * an append and "replace" and "add" are the same call — which is why the UI can
 * offer them as one control.
 */
function putCredential(params: PutParams): Promise<PutResult> {
  return ajaxPost({ url: '/api/v1/workspace_credentials', data: params });
}

// A stored key can change whether the hosted executor will take work, and that
// answer is cached for five minutes on the delegate control. Without the second
// key, someone adds the key the button told them to add and the button goes on
// refusing.
const CREDENTIAL_WRITE = {
  invalidates: [CREDENTIALS_KEY, 'agent-run-executors'],
  fallback: 'Could not save that credential.',
};

export const usePutCredentialMutation = mutationHook(
  putCredential,
  CREDENTIAL_WRITE,
);

function removeCredential({
  kind,
  provider,
}: {
  kind: CredentialKind;
  provider?: string;
}) {
  return ajaxDelete({
    url: `/api/v1/workspace_credentials/${kind}${
      provider ? `?provider=${encodeURIComponent(provider)}` : ''
    }`,
  });
}

export const useRemoveCredentialMutation = mutationHook(
  removeCredential,
  CREDENTIAL_WRITE,
);
