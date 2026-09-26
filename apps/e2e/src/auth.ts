import { expect, type APIRequestContext } from '@playwright/test';

import { SERVER_URL } from './env';
import { messageIdsTo, readLoginEmail, type LoginEmail } from './mailpit';

/**
 * SuperTokens answers in cookies for a browser and in response headers for
 * anything that asks with `st-auth-mode: header`. The suite asks, so a session
 * is a pair of strings it can put in an Authorization header.
 */
const SUPERTOKENS_HEADERS = {
  rid: 'passwordless',
  'st-auth-mode': 'header',
};

export interface Session {
  accessToken: string;
  refreshToken: string;
}

export interface SignIn {
  session: Session;
  email: LoginEmail;
}

/** Everything a test needs to act as one person in their own workspace. */
export interface Account {
  email: string;
  userId: string;
  workspaceId: string;
  workspaceSlug: string;
  teamId: string;
  teamIdentifier: string;
  /** A personal access token: the credential agents and the MCP use. */
  pat: string;
  /** A SuperTokens access token. It expires an hour after it is issued. */
  accessToken: string;
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function sessionFrom(headers: Record<string, string>): Session {
  const accessToken = headers['st-access-token'];
  const refreshToken = headers['st-refresh-token'];
  expect(accessToken, 'the response issued no access token').toBeTruthy();
  return { accessToken, refreshToken };
}

/** Asks the server to email a login code, as the sign-in page does. */
export async function requestLoginCode(
  request: APIRequestContext,
  email: string,
): Promise<{ deviceId: string; preAuthSessionId: string }> {
  const response = await request.post(
    `${SERVER_URL}/api/auth/signinup/code`,
    { headers: SUPERTOKENS_HEADERS, data: { email } },
  );
  expect(response, 'creating a login code failed').toBeOK();

  const body = await response.json();
  expect(body.status).toBe('OK');
  return { deviceId: body.deviceId, preAuthSessionId: body.preAuthSessionId };
}

/** Trades a login code for a session. Returns the raw response. */
export async function consumeLoginCode(
  request: APIRequestContext,
  code: { deviceId: string; preAuthSessionId: string },
  userInputCode: string,
) {
  return request.post(`${SERVER_URL}/api/auth/signinup/code/consume`, {
    headers: SUPERTOKENS_HEADERS,
    data: { ...code, userInputCode },
  });
}

/**
 * Signs in the way a person does: request a code, read it from the email the
 * server sent, type it back. Creates the account on first use.
 */
export async function signIn(
  request: APIRequestContext,
  email: string,
): Promise<SignIn> {
  const alreadySeen = await messageIdsTo(request, email);
  const code = await requestLoginCode(request, email);
  const loginEmail = await readLoginEmail(request, email, alreadySeen);

  const response = await consumeLoginCode(request, code, loginEmail.code);
  expect(response, 'consuming the login code failed').toBeOK();
  expect((await response.json()).status).toBe('OK');

  return { session: sessionFrom(response.headers()), email: loginEmail };
}

export interface OnboardingInput {
  workspaceName: string;
  fullname: string;
  teamName: string;
  teamIdentifier: string;
}

/** Creates the first workspace and team. Returns the raw response. */
export async function postOnboarding(
  request: APIRequestContext,
  session: Session,
  input: OnboardingInput,
) {
  return request.post(`${SERVER_URL}/v1/workspaces/onboarding`, {
    headers: { ...bearer(session.accessToken), ...SUPERTOKENS_HEADERS },
    data: input,
  });
}

/**
 * Onboards and returns the session the server re-issues, which is the first
 * one to carry the new workspace.
 */
export async function onboard(
  request: APIRequestContext,
  session: Session,
  input: OnboardingInput,
): Promise<Session> {
  const response = await postOnboarding(request, session, input);
  expect(response, 'onboarding failed').toBeOK();
  return sessionFrom(response.headers());
}

export async function createPersonalAccessToken(
  request: APIRequestContext,
  token: string,
  name: string,
): Promise<string> {
  const response = await request.post(`${SERVER_URL}/v1/users/pat`, {
    headers: bearer(token),
    data: { name },
  });
  expect(response, 'creating a personal access token failed').toBeOK();
  const body = await response.json();
  expect(body.token).toMatch(/^tg_pat_/);
  return body.token;
}

/**
 * A new person with their own workspace and team, signed in, holding both a
 * session and a personal access token.
 */
export async function provisionAccount(
  request: APIRequestContext,
  options: { email: string; fullname: string; workspaceName: string; teamIdentifier: string },
): Promise<Account> {
  const { session } = await signIn(request, options.email);

  const onboarded = await onboard(request, session, {
    workspaceName: options.workspaceName,
    fullname: options.fullname,
    teamName: `${options.fullname}'s team`,
    teamIdentifier: options.teamIdentifier,
  });

  const pat = await createPersonalAccessToken(
    request,
    onboarded.accessToken,
    'e2e',
  );

  const auth = { headers: bearer(pat) };

  const user = await request.get(`${SERVER_URL}/v1/users`, auth);
  expect(user, 'reading the current user failed').toBeOK();
  const { id: userId } = await user.json();

  const teams = await request.get(`${SERVER_URL}/v1/teams`, auth);
  expect(teams, 'listing teams failed').toBeOK();
  const [team] = await teams.json();
  expect(team?.identifier).toBe(options.teamIdentifier);

  const workspaces = await request.get(`${SERVER_URL}/v1/workspaces`, auth);
  expect(workspaces, 'listing workspaces failed').toBeOK();
  const workspace = (await workspaces.json()).find(
    (candidate: { id: string }) => candidate.id === team.workspaceId,
  );
  expect(workspace, 'the new workspace is not listed').toBeTruthy();

  return {
    email: options.email,
    userId,
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    teamId: team.id,
    teamIdentifier: team.identifier,
    pat,
    accessToken: onboarded.accessToken,
  };
}
