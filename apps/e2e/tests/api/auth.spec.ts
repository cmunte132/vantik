import {
  bearer,
  consumeLoginCode,
  createPersonalAccessToken,
  onboard,
  postOnboarding,
  requestLoginCode,
  signIn,
} from '../../src/auth';
import { runTag, SERVER_URL, WEBAPP_URL } from '../../src/env';
import { expect, test } from '../../src/fixtures';
import { readLoginEmail } from '../../src/mailpit';

function newEmail(who: string): string {
  return `${who}+${runTag()}@e2e.vantik.test`;
}

test.describe('signing in', () => {
  test('a new person signs in with the emailed code, onboards, and gets a working token', async ({
    request,
  }) => {
    const tag = runTag();
    const { session, email } = await signIn(request, newEmail('newcomer'));

    // The email links back to the webapp's verify page, not to the API server.
    const link = new URL(email.magicLink);
    expect(link.origin).toBe(new URL(WEBAPP_URL).origin);
    expect(link.pathname).toBe('/auth/verify');
    expect(link.searchParams.get('preAuthSessionId')).toBeTruthy();
    expect(link.hash.length).toBeGreaterThan(1);

    const onboarding = {
      workspaceName: `E2E Newcomer ${tag}`,
      fullname: 'Newcomer',
      teamName: 'Newcomers',
      teamIdentifier: 'NEW',
    };
    const onboarded = await onboard(request, session, onboarding);

    // The re-issued session is the one that names the new workspace. Onboarding
    // returned 500 on every fresh install for four days when this broke.
    const teams = await request.get(`${SERVER_URL}/v1/teams`, {
      headers: bearer(onboarded.accessToken),
    });
    expect(teams).toBeOK();
    expect((await teams.json()).map((t: { identifier: string }) => t.identifier)).toEqual([
      'NEW',
    ]);

    // A person onboards once.
    const again = await postOnboarding(request, onboarded, {
      ...onboarding,
      workspaceName: `${onboarding.workspaceName} again`,
    });
    expect(again.status()).toBe(400);

    // A personal access token acts in the workspace it was minted for.
    const pat = await createPersonalAccessToken(request, onboarded.accessToken, 'cli');
    const viaPat = await request.get(`${SERVER_URL}/v1/teams`, { headers: bearer(pat) });
    expect(viaPat).toBeOK();
    expect((await viaPat.json())[0].identifier).toBe('NEW');
  });

  test('a returning person signs in to the account they already have', async ({
    request,
    alice,
  }) => {
    const { session } = await signIn(request, alice.email);

    const user = await request.get(`${SERVER_URL}/v1/users`, {
      headers: bearer(session.accessToken),
    });
    expect(user).toBeOK();
    expect((await user.json()).id).toBe(alice.userId);
  });

  test('a wrong code is refused', async ({ request }) => {
    const email = newEmail('mistyped');
    const code = await requestLoginCode(request, email);
    const { code: realCode } = await readLoginEmail(request, email, []);

    const response = await consumeLoginCode(request, code, `${realCode}x`);

    expect(response).toBeOK();
    expect((await response.json()).status).toBe('INCORRECT_USER_INPUT_CODE_ERROR');
    expect(response.headers()['st-access-token']).toBeUndefined();
  });
});

test.describe('credentials', () => {
  test('a request with no credentials is refused', async ({ anonymous }) => {
    expect((await anonymous.get('/v1/teams')).status()).toBe(401);
    expect(
      (await anonymous.post('/v1/issues/filter', { data: { filters: {} } })).status(),
    ).toBe(401);
  });

  test('an unknown personal access token is refused', async ({ anonymous }) => {
    const response = await anonymous.get('/v1/teams', {
      headers: bearer('tg_pat_this-token-was-never-issued'),
    });
    expect(response.status()).toBe(401);
  });

  test('a garbage bearer token is refused', async ({ anonymous }) => {
    const response = await anonymous.get('/v1/teams', {
      headers: bearer('not-a-jwt'),
    });
    expect(response.status()).toBe(401);
  });

  test('a personal access token keeps working', async ({ asAlice, alice }) => {
    // The setup project minted this token before any test ran. PATs used to
    // die an hour after they were issued; this only proves they outlive the
    // request that made them, but it is the path that broke.
    const response = await asAlice.get('/v1/users');
    expect(response).toBeOK();
    expect((await response.json()).id).toBe(alice.userId);
  });
});
