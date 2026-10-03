import { expect, type APIRequestContext } from '@playwright/test';

import { SERVER_URL } from './env';
import {
  messageIdsTo,
  readEmail,
  readLoginEmail,
  type LoginEmail,
} from './mailpit';

const AUTH_HEADERS = {
  'Content-Type': 'application/json',
};
/** A session token. The server sets it as a cookie and also accepts it as a
 * bearer token, which is how the suite sends it. */
export interface Session {
  accessToken: string;
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
  /** A session token. The session slides forward while it is used. */
  accessToken: string;
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function sessionFrom(headers: Record<string, string>): Session {
  const token = headers['set-cookie']?.match(/sSessionToken=([^;]+)/)?.[1];
  expect(token, 'the response issued no session token').toBeTruthy();
  return { accessToken: token! };
}

/** Asks the server to email a login code, as the sign-in page does. */
export async function requestLoginCode(
  request: APIRequestContext,
  email: string,
): Promise<{ deviceId: string; preAuthSessionId: string }> {
  const response = await request.post(
    `${SERVER_URL}/v1/auth/signinup/code`,
    { headers: AUTH_HEADERS, data: { email } },
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
  return request.post(`${SERVER_URL}/v1/auth/signinup/code/consume`, {
    headers: AUTH_HEADERS,
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
    headers: { ...bearer(session.accessToken), ...AUTH_HEADERS },
    data: input,
  });
}

/**
 * Onboards. The session keeps its token: the server moves it to the new
 * workspace and issues nothing new.
 */
export async function onboard(
  request: APIRequestContext,
  session: Session,
  input: OnboardingInput,
): Promise<Session> {
  const response = await postOnboarding(request, session, input);
  expect(response, 'onboarding failed').toBeOK();
  expect(
    response.headers()['set-cookie'],
    'onboarding re-issued the session',
  ).toBeUndefined();
  return session;
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

/** Who the token belongs to, and the workspace it acts in. */
async function identify(
  request: APIRequestContext,
  pat: string,
  workspaceId: string,
): Promise<{ userId: string; workspaceSlug: string }> {
  const auth = { headers: bearer(pat) };

  const user = await request.get(`${SERVER_URL}/v1/users`, auth);
  expect(user, 'reading the current user failed').toBeOK();

  const workspaces = await request.get(`${SERVER_URL}/v1/workspaces`, auth);
  expect(workspaces, 'listing workspaces failed').toBeOK();
  const workspace = (await workspaces.json()).find(
    (candidate: { id: string }) => candidate.id === workspaceId,
  );
  expect(workspace, 'the workspace is not listed').toBeTruthy();

  return { userId: (await user.json()).id, workspaceSlug: workspace.slug };
}

/**
 * Invites `email` into `inviter`'s workspace, to one team, the way the members
 * settings page does, and waits for the invite email.
 */
export async function invite(
  request: APIRequestContext,
  inviter: Account,
  email: string,
  teamId: string,
): Promise<void> {
  const seenBeforeInvite = await messageIdsTo(request, email);

  const invited = await request.post(
    `${SERVER_URL}/v1/workspaces/invite_users`,
    {
      headers: bearer(inviter.pat),
      data: { emailIds: email, teamIds: [teamId], role: 'USER' },
    },
  );
  expect(invited, 'inviting a teammate failed').toBeOK();
  expect((await invited.json())[email]).toBe('Success');

  // Waiting for it also means a sign-in after this reads the email that
  // carries the code, and not this one.
  await readEmail(request, email, /^Invite to /, seenBeforeInvite);
}

/** The id of the open invite into `workspaceId` on the signed-in user. */
export async function inviteIdFor(
  request: APIRequestContext,
  session: Session,
  workspaceId: string,
): Promise<string> {
  const user = await request.get(`${SERVER_URL}/v1/users`, {
    headers: bearer(session.accessToken),
  });
  expect(user, 'reading the invited user failed').toBeOK();
  const found = (
    (await user.json()).invites as Array<{ id: string; workspaceId: string }>
  ).find((candidate) => candidate.workspaceId === workspaceId);
  expect(found, 'the invite is not on the invited user').toBeTruthy();
  return found!.id;
}

/** Accepts or declines an invite. Returns the raw response. */
export async function answerInvite(
  request: APIRequestContext,
  session: Session,
  inviteId: string,
  accept = true,
) {
  return request.post(`${SERVER_URL}/v1/workspaces/invite_action`, {
    headers: { ...bearer(session.accessToken), ...AUTH_HEADERS },
    data: { inviteId, accept },
  });
}

/**
 * A person invited into `inviter`'s workspace, to one of its teams, who signs
 * in with a code of their own, finds the invite on their user and accepts it.
 */
export async function provisionTeammate(
  request: APIRequestContext,
  inviter: Account,
  options: { email: string; team: { id: string; identifier: string } },
): Promise<Account> {
  await invite(request, inviter, options.email, options.team.id);

  const { session } = await signIn(request, options.email);
  const inviteId = await inviteIdFor(request, session, inviter.workspaceId);

  const accepted = await answerInvite(request, session, inviteId);
  expect(accepted, 'accepting the invite failed').toBeOK();

  // Like onboarding, accepting moves the same session to the workspace just
  // joined.
  const pat = await createPersonalAccessToken(request, session.accessToken, 'e2e');

  return {
    email: options.email,
    ...(await identify(request, pat, inviter.workspaceId)),
    workspaceId: inviter.workspaceId,
    teamId: options.team.id,
    teamIdentifier: options.team.identifier,
    pat,
    accessToken: session.accessToken,
  };
}

/**
 * A new person with their own workspace and team, signed in, holding both a
 * session and a personal access token.
 */
export async function provisionAccount(
  request: APIRequestContext,
  options: {
    email: string;
    fullname: string;
    workspaceName: string;
    teamIdentifier: string;
    teamName?: string;
  },
): Promise<Account> {
  const { session } = await signIn(request, options.email);

  const onboarded = await onboard(request, session, {
    workspaceName: options.workspaceName,
    fullname: options.fullname,
    teamName: options.teamName ?? `${options.fullname}'s team`,
    teamIdentifier: options.teamIdentifier,
  });

  const pat = await createPersonalAccessToken(
    request,
    onboarded.accessToken,
    'e2e',
  );

  const teams = await request.get(`${SERVER_URL}/v1/teams`, {
    headers: bearer(pat),
  });
  expect(teams, 'listing teams failed').toBeOK();
  const [team] = await teams.json();
  expect(team?.identifier).toBe(options.teamIdentifier);

  return {
    email: options.email,
    ...(await identify(request, pat, team.workspaceId)),
    workspaceId: team.workspaceId,
    teamId: team.id,
    teamIdentifier: team.identifier,
    pat,
    accessToken: onboarded.accessToken,
  };
}
