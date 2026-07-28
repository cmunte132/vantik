import { Loader } from '@vantikhq/ui/components/loader';
import { ScrollArea } from '@vantikhq/ui/components/scroll-area';
import { useParams } from 'next/navigation';

import { Header } from 'modules/settings/header';
import { SettingSection } from 'modules/settings/setting-section';

import { ContentBox } from 'common/layouts/content-box';
import { SettingsLayout } from 'common/layouts/settings-layout';

import { useGetIntegrationDefinition } from 'services/integration-definition';

import { IntegrationAuth } from './integration-auth';
import { LocalRepositories } from './local-repositories';

export function Integration() {
  const { integrationDefinitionId } = useParams();
  const { data: integrationDefinition, isLoading } =
    useGetIntegrationDefinition(integrationDefinitionId as string);

  return (
    <>
      <ContentBox>
        {!isLoading && <Header title={integrationDefinition.name} />}
        <ScrollArea className="flex grow h-full">
          <div className="w-full p-4">
            {!isLoading && (
              <SettingSection
                title={integrationDefinition.name}
                description={integrationDefinition.description}
              >
                {/*
                  An integration that declares `local_auth` has no account to
                  authorise. It gets a form here, where the others get a
                  Connect button that starts an OAuth flow.
                */}
                {integrationDefinition.spec?.local_auth ? (
                  <LocalRepositories
                    instruction={
                      integrationDefinition.spec.local_auth.instruction
                    }
                  />
                ) : (
                  <>
                    <IntegrationAuth
                      integrationDefinition={integrationDefinition}
                    />
                    {integrationDefinition.spec?.personal_auth && (
                      <IntegrationAuth
                        integrationDefinition={integrationDefinition}
                        personal
                      />
                    )}
                  </>
                )}
              </SettingSection>
            )}

            {isLoading && (
              <Loader text="Fetching specification (Currently optimizing for faster performance.)" />
            )}
          </div>
        </ScrollArea>
      </ContentBox>
    </>
  );
}

Integration.getLayout = function getLayout(page: React.ReactElement) {
  return (
    <SettingsLayout>
      <div className="h-[100vh] flex flex-col w-full">{page}</div>
    </SettingsLayout>
  );
};
