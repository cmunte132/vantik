import { Loader } from '@vantikhq/ui/components/loader';
import { observer } from 'mobx-react-lite';
import * as React from 'react';
import { Socket, io } from 'socket.io-client';

import { hash } from 'common/common-utils';
import { loadClientConfig } from 'common/lib/client-config';
import { noteServerDeployAnnouncement } from 'common/wrappers/app-version-provider';

import { useCurrentWorkspace } from 'hooks/workspace';

import { getDeltaRecords } from 'services/sync';

import { useContextStore } from 'store/global-context-provider';
import { MODELS } from 'store/models';
import { resync } from 'store/resync';
import { UserContext } from 'store/user-context';

import { modelStoreMap, saveSocketData } from './socket-data-util';

interface Props {
  children: React.ReactElement;
}

// This wrapper ensures the data received from the socket is passed to indexed DB
export const SocketDataSyncWrapper: React.FC<Props> = observer(
  (props: Props) => {
    const { children } = props;
    const workspace = useCurrentWorkspace();

    const stores = useContextStore();
    const { workspaceStore } = stores;
    const user = React.useContext(UserContext);
    const hashKey = `${workspace.id}__${user.id}`;

    const [socket, setSocket] = React.useState<Socket | undefined>(undefined);
    const retryTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);

    React.useEffect(() => {
      if (!socket && workspaceStore.workspace?.id) {
        initSocket();
      }

      return () => {
        socket && socket.disconnect();
        clearTimeout(retryTimer.current);
      };

      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [workspaceStore.workspace]);

    async function initSocket() {
      // The gateway is mounted on the server's own port and is not proxied
      // through this app, so it needs an absolute origin rather than a path.
      const { socketHost } = await loadClientConfig();

      // No host means the config never landed. Connecting anyway is worse than
      // waiting: io('') points socket.io at this app's own origin, where there
      // is no gateway, so the page would sit there looking connected with every
      // live update going nowhere. loadClientConfig retries a failure, so
      // asking again is what eventually gets a real host.
      if (!socketHost) {
        retryTimer.current = setTimeout(initSocket, 5000);

        return;
      }

      const socket = io(socketHost, {
        query: {
          workspaceId: workspaceStore.workspace.id,
          userId: user.id,
        },
        withCredentials: true,
      });
      setSocket(socket);

      const MODEL_STORE_MAP = modelStoreMap(stores);
      const sequenceKey = `lastSequenceId_${hash(hashKey)}`;

      // Everything reaches the store in the order it arrived, so a delta
      // fetched on connecting cannot land over a newer live message.
      let applying = Promise.resolve();
      const inOrder = (work: () => Promise<void>) => {
        const next = applying.then(work);
        applying = next.catch((): void => undefined);
        return next;
      };

      // A live message covers only the time the socket is connected. Whatever
      // was announced before it first connected, or while it was reconnecting
      // after a drop, never arrives, and the page went without it until it was
      // reloaded. So each time it connects, it asks for what it missed.
      const catchUp = async () => {
        const lastSequenceId = localStorage.getItem(sequenceKey);

        // None yet: the bootstrap is still bringing everything up to now.
        if (!lastSequenceId || !/^\d+$/.test(lastSequenceId)) {
          return;
        }

        const delta = await getDeltaRecords(
          workspaceStore.workspace.id,
          Object.values(MODELS),
          lastSequenceId,
          user.id,
        );

        if (delta.resync) {
          await resync();
          return;
        }

        await saveSocketData(delta.syncActions, MODEL_STORE_MAP);
        localStorage.setItem(sequenceKey, `${delta.lastSequenceId}`);
      };

      // A catch-up that fails leaves things as they were before it existed;
      // the next reconnection tries again.
      socket.on('connect', () => {
        inOrder(catchUp).catch((): void => undefined);
      });

      socket.on('message', (newMessage: string) =>
        inOrder(async () => {
          const data = JSON.parse(newMessage);

          await saveSocketData([data], MODEL_STORE_MAP);
          localStorage.setItem(sequenceKey, `${data.sequenceId}`);
        }),
      );

      // The fastest deploy signal available: this connection is already open, so
      // a window that has been sitting untouched for days hears about a new
      // build in seconds instead of waiting for the next poll. What arrives is
      // the server image's stamp, which is a prompt to go and ask /api/version —
      // not an answer about the bundle.
      socket.on('server-version', () => {
        noteServerDeployAnnouncement();
      });

      // A team is a visibility boundary (ENG-79), so a change of team changes
      // what this client may hold. The server moves the socket between rooms and
      // then sends this.
      //
      // A delta cannot do the work. The records of a team just joined were
      // announced long ago, and they sit below the sequence id in localStorage —
      // so the client asks for everything after that id and is told, correctly,
      // that there is nothing. The store has to be built again from the start.
      // The same call also drops the records of a team the person has left.
      socket.on('resync', async () => {
        await resync();
      });
    }

    if (workspaceStore?.workspace) {
      return <>{children}</>;
    }

    return <Loader height={500} text="Loading workspace..." />;
  },
);
