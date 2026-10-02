import { Button } from '@vantikhq/ui/components/button';
import { Logo } from '@vantikhq/ui/components/dynamic-logo';
import { Loader } from '@vantikhq/ui/components/loader';
import * as React from 'react';

import { deleteCookies } from 'common/common-utils';
import { useRouter } from 'common/router';

import { signOut } from 'services/auth';
import { useGetUserQuery } from 'services/users';

import { UserContext } from 'store/user-context';

interface Props {
  children: React.ReactElement;
}

export function UserDataWrapper(props: Props): React.ReactElement {
  const { children } = props;
  const { data, error: isError, isLoading } = useGetUserQuery();
  const {
    query: { workspaceSlug },
    replace,
  } = useRouter();

  const workspaceRes =
    !isLoading && !isError
      ? data.workspaces.find((work) => work.slug === workspaceSlug)
      : undefined;
  // A workspace address this user does not belong to: a deleted workspace, a
  // link from another account, or the page that was open when the session
  // ended. Everything below assumes the workspace is the user's, so send them
  // to /, which picks their workspace, their invites, or onboarding.
  const notMember = !isLoading && !isError && !!workspaceSlug && !workspaceRes;

  React.useEffect(() => {
    if (notMember) {
      replace('/');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notMember]);

  if (!isLoading && !isError && !notMember) {
    if (workspaceRes?.status === 'SUSPENDED') {
      return (
        <div className="flex flex-col h-[100vh] w-[100vw] items-center justify-center gap-2">
          <Logo width={100} height={100} /> Your account is suspended
          <Button
            variant="secondary"
            onClick={async () => {
              deleteCookies();
              await signOut();

              replace('/auth');
            }}
          >
            Logout
          </Button>
        </div>
      );
    }

    return <UserContext.Provider value={data}>{children}</UserContext.Provider>;
  }

  return <Loader text="Loading user data" />;
}
