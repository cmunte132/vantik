export enum MODELS {
  Workspace = 'Workspace',
  Team = 'Team',
  Label = 'Label',
  UsersOnWorkspaces = 'UsersOnWorkspaces',
  View = 'View',
  Action = 'Action',

  // Team
  Workflow = 'Workflow',
  Issue = 'Issue',
  IssueHistory = 'IssueHistory',
  IssueComment = 'IssueComment',
  ChecklistItem = 'ChecklistItem',
  AgentRun = 'AgentRun',
  AgentRunEvent = 'AgentRunEvent',
  IntegrationDefinition = 'IntegrationDefinition',
  IntegrationAccount = 'IntegrationAccount',
  LinkedIssue = 'LinkedIssue',
  IssueRelation = 'IssueRelation',
  Notification = 'Notification',
  IssueSuggestion = 'IssueSuggestion',
  Page = 'Page',
  PageEntry = 'PageEntry',
  Project = 'Project',
  ProjectMilestone = 'ProjectMilestone',

  // The product axis. Product groups the modules and holds no code. Module is
  // usually one repository. Capability is what the software does, and it names
  // the modules that hold its code.
  Product = 'Product',
  Module = 'Module',
  Capability = 'Capability',
  Cycle = 'Cycle',
  Conversation = 'Conversation',
  ConversationHistory = 'ConversationHistory',
  Template = 'Template',

  // Support
  Support = 'Support',
  People = 'People',
  Company = 'Company',
}
