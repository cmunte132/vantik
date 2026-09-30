import { Loader } from '@vantikhq/ui/components/loader';
import React, { cloneElement } from 'react';
import { doesSessionExist } from 'services/auth';

import { useRouter } from 'common/router';

interface Props {
  children: React.ReactElement;
}

export function AuthGuard(props: Props): React.ReactElement {
  const { children } = props;
  const router = useRouter();
  const [isLoading, setLoading] = React.useState(true);

  React.useEffect(() => {
    checkForSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function checkForSession() {
    if (await doesSessionExist()) {
      router.replace('/');
    } else {
      setLoading(false);
    }
  }

  if (!isLoading) {
    return cloneElement(children);
  }

  return <Loader />;
}
