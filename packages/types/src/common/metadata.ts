export class SourceMetadata {
  integrationAccountId: string;
  userDisplayName?: string;
  // Integration type (github)
  type: string;

  // Ex: channelId for a chat integration
  identifier?: string;
}
