import Router from 'next/router';
import Passwordless from 'supertokens-auth-react/recipe/passwordless';
import SessionReact from 'supertokens-auth-react/recipe/session';

export const frontendConfig = () => {
  // The API is proxied through this same origin at /api, and the auth UI is
  // served from it too, so both domains are just wherever the page was loaded
  // from. Deriving them keeps SuperTokens init synchronous and correct for any
  // hostname an install is reached on.
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  const appInfo = {
    appName: 'Vantik',
    apiDomain: origin,
    websiteDomain: origin,
    apiBasePath: '/api/auth',
    websiteBasePath: '/auth',
  };

  return {
    appInfo,
    recipeList: [
      Passwordless.init({
        contactMethod: 'EMAIL',
      }),
      // Session cookies are same-origin now that apiDomain matches the page
      // origin, so there is no backend domain to pin. The previous build
      // hardcoded '.vantik.dev' whenever NODE_ENV was production, which broke
      // sessions for every self-hosted install on its own domain.
      SessionReact.init(),
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    windowHandler: (oI: any) => {
      return {
        ...oI,
        location: {
          ...oI.location,
          setHref: (href: string) => {
            Router.push(href);
          },
        },
      };
    },
  };
};
