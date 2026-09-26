import type { IntegrationDefinition } from '@vantikhq/types';

import { Button } from '@vantikhq/ui/components/button';
import { observer } from 'mobx-react-lite';

import { useCurrentWorkspace } from 'hooks/workspace';

import { useConnectIntegrationMutation } from 'services/integration-account';
import { useDeleteIntegrationAccount } from 'services/oauth';

import { useIntegrationAccount } from './integration-util';

/**
 * On and off for an integration with nobody to authorise.
 *
 * The Bug Enricher talks to no vendor, so there is no OAuth window to open.
 * It still acts only for a workspace that turned it on, which is what the
 * account this makes records.
 */
export const NoAuthConnect = observer(
  ({
    integrationDefinition,
    instruction,
  }: {
    integrationDefinition: IntegrationDefinition;
    instruction: string;
  }) => {
    const workspace = useCurrentWorkspace();
    const integrationAccount = useIntegrationAccount(integrationDefinition.id);

    const { mutate: connect, isPending: connecting } =
      useConnectIntegrationMutation();
    const { mutate: disconnect, isPending: disconnecting } =
      useDeleteIntegrationAccount({});

    return (
      <div className="p-3 border rounded bg-background-3 flex items-center justify-between gap-3">
        <div className="flex flex-col items-start justify-center">
          <p className="font-medium">
            {integrationAccount ? 'On for this workspace' : 'Off'}
          </p>
          <p className="text-muted-foreground">{instruction}</p>
        </div>

        {integrationAccount ? (
          <Button
            variant="destructive"
            onClick={() =>
              disconnect({ integrationAccountId: integrationAccount.id })
            }
            isLoading={disconnecting}
          >
            Turn off
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="lg"
            onClick={() =>
              connect({
                integrationDefinitionId: integrationDefinition.id,
                workspaceId: workspace.id,
              })
            }
            isLoading={connecting}
          >
            Turn on
          </Button>
        )}
      </div>
    );
  },
);
