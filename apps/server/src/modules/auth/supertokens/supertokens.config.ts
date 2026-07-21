import { MailerService } from '@nestjs-modules/mailer';
import { TypePasswordlessEmailDeliveryInput } from 'supertokens-node/lib/build/recipe/passwordless/types';
import jwt from 'supertokens-node/recipe/jwt';
import Passwordless from 'supertokens-node/recipe/passwordless';
import Session from 'supertokens-node/recipe/session';
import UserRoles from 'supertokens-node/recipe/userroles';
import WebAuthn from 'supertokens-node/recipe/webauthn';

import { LoggerService } from 'modules/logger/logger.service';
import { UsersService } from 'modules/users/users.service';

const logger = new LoggerService('Supertokens');

/**
 * The domain the *browser* sees, which is what a passkey is bound to.
 *
 * WebAuthn scopes every credential to a relying party id, and the browser
 * refuses to hand back a credential whose relying party id does not match the
 * page it is on. That makes this the frontend host and never the API host, and
 * it is why the value cannot be supplied by the client.
 */
function frontendOrigin() {
  return (process.env.FRONTEND_HOST ?? '').split(',')[0] ?? '';
}

function relyingPartyId() {
  const origin = frontendOrigin();

  // Falling back to localhost keeps a bare `pnpm dev` working: WebAuthn only
  // permits localhost as a secure origin without TLS.
  return origin ? new URL(origin).hostname : 'localhost';
}

/**
 * Whether someone with no account can create one by registering a passkey.
 *
 * On a local single-user install this is the whole point: there is no mail
 * server, and a passkey is the only credential involved. A team install may
 * instead want everyone to arrive through an invite, so this can be turned off,
 * leaving passkeys as something you add to an account you already have.
 */
function passkeySignupEnabled() {
  return process.env.PASSKEY_SIGNUP_ENABLED !== 'false';
}

function logEmail(email: string, link?: string, code?: string) {
  const message = `##### sendEmail to ${email}, subject: Login email

Log in to Vantik.ai

Enter this login code in the app:
${code}

Or click here to log in with this magic link:
${link}\n\n`;

  if (process.env.NODE_ENV !== 'production') {
    logger.info({ message });
  }
}

export const recipeList = (
  usersService: UsersService,
  mailerService: MailerService,
) => {
  const isProd = process.env.NODE_ENV === 'production';
  const cookieSettings = isProd
    ? {
        cookieDomain: process.env.SUPERTOKENS_DOMAIN,
        olderCookieDomain: '',
        cookieSecure: true,
      }
    : {};

  return [
    jwt.init(),
    UserRoles.init(),
    // NOTE: account linking is deliberately *not* initialised here. The
    // SuperTokens core refuses it without a licence — every sign-in comes back
    // 402 "Account linking feature is not enabled for this app" from
    // /recipe/accountlinking/user/primary — which takes the email login down
    // with it, not just the passkey flow. Until that is settled, a passkey and
    // a login code for the same address are two separate SuperTokens users,
    // which is why passkey signup is limited to addresses nobody has claimed.
    Session.init({
      ...cookieSettings,
      override: {
        functions(originalImplementation) {
          return {
            ...originalImplementation,
            async createNewSession(input) {
              // since frontend needs workspaces we converted usersOnWorkspaces
              // To workspaces
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const user = (await usersService.getUser(input.userId)) as any;
              const workspace = user.workspaces[0];

              const workspaceData = workspace
                ? { workspaceId: workspace.id, role: workspace.role }
                : {};

              input.accessTokenPayload = {
                ...input.accessTokenPayload,
                ...workspaceData,
              };

              return originalImplementation.createNewSession(input);
            },
          };
        },
      },
    }), // initializes session features
    Passwordless.init({
      contactMethod: 'EMAIL',
      flowType: 'USER_INPUT_CODE_AND_MAGIC_LINK',
      emailDelivery: {
        override: (originalImplementation) => {
          return {
            ...originalImplementation,
            async sendEmail({
              email,
              urlWithLinkCode,
              userInputCode,
              codeLifetime,
            }: TypePasswordlessEmailDeliveryInput) {
              logEmail(email, urlWithLinkCode, userInputCode);

              try {
                await mailerService.sendMail({
                  to: email,
                  subject: 'Login for Vantik',
                  template: 'loginUser',
                  context: {
                    userName: email.split('@')[0],
                    magicLink: urlWithLinkCode,
                    loginCode: userInputCode,
                    linkExpiresIn: Math.floor(codeLifetime / 60000),
                  },
                });
              } catch (error) {
                logger.error({
                  message: `Error while sending mail`,
                  where: `supertokens.config.recipeList`,
                  error,
                });
              }
            },
          };
        },
      },
      override: {
        functions: (originalImplementation) => {
          return {
            ...originalImplementation,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            consumeCode: async (input: any) => {
              // First we call the original implementation of consumeCode.
              const response = await originalImplementation.consumeCode(input);

              // Post sign up response, we check if it was successful
              if (response.status === 'OK') {
                const { id, emails } = response.user;
                const email = emails[0];

                if (input.session === undefined) {
                  if (
                    response.createdNewRecipeUser &&
                    response.user.loginMethods.length === 1
                  ) {
                    await usersService.upsertUser(
                      id,
                      email,
                      email.split('@')[0],
                    );
                  }
                }
              }
              return response;
            },
          };
        },
      },
    }),
    WebAuthn.init({
      getRelyingPartyId: () => Promise.resolve(relyingPartyId()),
      getRelyingPartyName: () => Promise.resolve('Vantik'),
      getOrigin: () => Promise.resolve(frontendOrigin()),
      override: {
        apis: (originalImplementation) => {
          return {
            ...originalImplementation,
            // SuperTokens can mail a recovery link that registers a fresh
            // passkey. We do not use it: the magic link already recovers any
            // account, so a second recovery channel would be a second way in
            // to defend for no gain. Leaving the API mounted but unhandled is
            // what closes it.
            generateRecoverAccountTokenPOST: undefined,
            recoverAccountPOST: undefined,
            registerOptionsPOST: async (input) => {
              // Without account linking, a passkey registered against an email
              // that already has an account becomes a *second* SuperTokens
              // user sharing one address. The session it mints then carries an
              // id no `User` row has, and `createNewSession` dies looking it
              // up. Refusing here stops that before the browser even asks for
              // a fingerprint.
              const email = 'email' in input ? input.email : undefined;

              if (email && (await usersService.getUserByEmail(email))) {
                return {
                  status: 'INVALID_EMAIL_ERROR',
                  err: 'That email already has an account. Sign in with a login code instead.',
                };
              }

              return originalImplementation.registerOptionsPOST!(input);
            },
            signUpPOST: async (input) => {
              // A passkey belonging to nobody yet means account creation. An
              // install that funnels people through invites can refuse that
              // while still allowing a passkey to be added to an existing
              // account, which arrives here carrying a session.
              if (input.session === undefined && !passkeySignupEnabled()) {
                return {
                  status: 'SIGN_UP_NOT_ALLOWED',
                  reason:
                    'Creating an account with a passkey is disabled on this instance. Sign in with your email first, then add a passkey.',
                };
              }

              return originalImplementation.signUpPOST!(input);
            },
          };
        },
        functions: (originalImplementation) => {
          return {
            ...originalImplementation,
            signUp: async (input) => {
              const response = await originalImplementation.signUp(input);

              // Mirrors the passwordless path: SuperTokens owns the login
              // method, we own the row the rest of the product reads. Guarding
              // on a single login method keeps a passkey added to an existing
              // account from being mistaken for a new signup, and `user.id` is
              // the primary user id, so a linked account resolves to the row
              // it already had.
              if (response.status === 'OK') {
                const { id, emails, loginMethods } = response.user;
                const email = emails[0];

                if (input.session === undefined && loginMethods.length === 1) {
                  await usersService.upsertUser(id, email, email.split('@')[0]);
                }
              }

              return response;
            },
          };
        },
      },
    }),
  ];
};
