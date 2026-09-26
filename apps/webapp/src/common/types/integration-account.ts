export interface IntegrationAccountType {
  id: string;
  createdAt: string;
  updatedAt: string;

  accountId: string | null;
  settings: string | null;
  personal: boolean;

  integratedById: string;
  integrationDefinitionId: string;
  workspaceId: string;
}
